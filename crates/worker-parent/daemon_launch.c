#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include <mach-o/dyld.h>
#include <sys/socket.h>
#include "state_cleanup.h"

int main(int argc,char **argv) {
    if(argc>=2 && (strcmp(argv[1],"--djls-clean-owned-state")==0 || strcmp(argv[1],"--djls-clean-owned-state-v2")==0))return cleanup_leased_state(argc,argv);
    int state_channel=-1;char *fields[7];
    if(argc>=13 && strcmp(argv[1],"--djls-native-state-root")==0) {
        if(strcmp(argv[2],"3") || strcmp(argv[3],"4") || strcmp(argv[4],"5") || strcmp(argv[12],"--"))return 126;
        struct stat info;int type;socklen_t n=sizeof type;
        if(fstat(3,&info)<0 || !S_ISSOCK(info.st_mode) || getsockopt(3,SOL_SOCKET,SO_TYPE,&type,&n)<0 || type!=SOCK_STREAM)return 126;
        for(int i=0;i<7;++i)fields[i]=argv[i+5];
        struct state_lease lease;if(parse_state_lease(fields,&lease)<0 || lease.uid!=getuid())return 126;
        state_channel=3;argv[12]=argv[0];argv+=12;argc-=12;
    }
    if(argc<2)return 126;
    struct stat info;
    if(fstat(STDIN_FILENO,&info)<0)return 126;
    if(!S_ISFIFO(info.st_mode) && !S_ISSOCK(info.st_mode)) {
        if(state_channel>=0)return 126;
        execvp(argv[0],argv);return 127;
    }
    int reader=fcntl(STDIN_FILENO,F_DUPFD,6);if(reader<0)return 126;
    char executable[PATH_MAX],resolved[PATH_MAX];uint32_t size=sizeof executable;
    if(_NSGetExecutablePath(executable,&size)!=0 || !realpath(executable,resolved))return 126;
    char *slash=strrchr(resolved,'/');if(!slash)return 126;*slash='\0';
    const char *filename="/daemon-parent-guard.dylib";
    size_t library_size=strlen(resolved)+strlen(filename)+1;
    char *library=malloc(library_size);if(!library)return 126;
    snprintf(library,library_size,"%s%s",resolved,filename);
    const char *original=getenv("DYLD_INSERT_LIBRARIES");
    if(setenv("DJLS_NATIVE_PARENT_PRELOAD_PRESENT",original?"1":"0",1)<0
        || setenv("DJLS_NATIVE_PARENT_PRELOAD_ORIGINAL",original?original:"",1)<0)return 126;
    size_t preload_size=strlen(library)+((original&&*original)?strlen(original)+1:0)+1;
    char *preload=malloc(preload_size);if(!preload)return 126;
    if(original&&*original)snprintf(preload,preload_size,"%s:%s",library,original);
    else snprintf(preload,preload_size,"%s",library);
    char encoded[8192];int n;
    if(state_channel>=0)n=snprintf(encoded,sizeof encoded,"%d:3:%s:%s:%s:%s:%s:%s:%s",reader,fields[0],fields[1],fields[2],fields[3],fields[4],fields[5],fields[6]);
    else n=snprintf(encoded,sizeof encoded,"%d",reader);
    if(n<0 || (size_t)n>=sizeof encoded || setenv("DYLD_INSERT_LIBRARIES",preload,1)<0
        || setenv("DJLS_NATIVE_DAEMON_FD",encoded,1)<0)return 126;
    execvp(argv[0],argv);return 127;
}
