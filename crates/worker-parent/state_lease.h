#ifndef DJLS_STATE_LEASE_H
#define DJLS_STATE_LEASE_H
#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>

struct state_lease {
    pid_t allocator;
    uid_t uid;
    uintmax_t parent_dev, parent_ino, root_dev, root_ino;
    char path[PATH_MAX];
};

static inline int lease_number(const char *text, uintmax_t *value) {
    if (!text || !*text || (*text == '0' && text[1])) return -1;
    for (const char *p=text;*p;++p) if (*p<'0' || *p>'9') return -1;
    errno=0;char *end;*value=strtoumax(text,&end,10);
    return errno || *end ? -1 : 0;
}

static inline int lease_hex_digit(char value) {
    if (value>='0' && value<='9') return value-'0';
    if (value>='a' && value<='f') return value-'a'+10;
    return -1;
}

static inline int lease_path_name(const struct state_lease *lease, const char **name) {
    if (lease->path[0]!='/') return -1;
    const char *last=strrchr(lease->path,'/');
    if (!last || last==lease->path) return -1;
    *name=last+1;
    char prefix[128];
    int n=snprintf(prefix,sizeof prefix,"djls-owned-worker-state-%ld-",(long)lease->allocator);
    if (n<0 || (size_t)n>=sizeof prefix || strncmp(*name,prefix,(size_t)n) || strlen(*name+n)!=6) return -1;
    for (const char *p=*name+n;*p;++p) {
        if (!((*p>='a'&&*p<='z')||(*p>='A'&&*p<='Z')||(*p>='0'&&*p<='9'))) return -1;
    }
    return 0;
}

static inline int parse_state_lease(char *const *fields, struct state_lease *lease) {
    uintmax_t v[6];
    for (int i=0;i<6;++i) if (lease_number(fields[i],&v[i])<0) return -1;
    if (!v[0] || v[0]>INT_MAX || (uintmax_t)(uid_t)v[1]!=v[1]) return -1;
    lease->allocator=(pid_t)v[0];lease->uid=(uid_t)v[1];
    lease->parent_dev=v[2];lease->parent_ino=v[3];lease->root_dev=v[4];lease->root_ino=v[5];
    size_t n=strlen(fields[6]);
    if (!n || n%2 || n/2>=sizeof lease->path) return -1;
    for (size_t i=0;i<n/2;++i) {
        int a=lease_hex_digit(fields[6][i*2]),b=lease_hex_digit(fields[6][i*2+1]);
        if (a<0 || b<0 || (a==0 && b==0)) return -1;
        lease->path[i]=(char)((a<<4)|b);
    }
    lease->path[n/2]='\0';
    const char *name;
    return lease_path_name(lease,&name);
}
#endif
