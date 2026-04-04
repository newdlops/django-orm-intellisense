from blog import AuditLog, Company, MultiInheritedLog, Post


def lookup_examples():
    Post.objects.values("author__pro")
    Post.objects.values("author__")
    Post.objects.values("author__profile__timezone")
    Post.objects.select_related("author__profile")
    Post.objects.order_by("author__name")
    Post.objects.filter(auth='mentor')
    Post.objects.filter()
    Post.objects.filter(author__pro='mentor')
    Post.objects.filter(author__='mentor')
    Post.objects.filter(author__profile__timezone='Asia/Seoul')
    Post.objects.filter(author__profile__timezone__='Asia/Seoul')
    Post.objects.filter(author__profile__timezone__i='Asia/Seoul')
    Post.objects.filter(author_i=1)
    Post.objects.filter(author_id__in=[1, 2])
    Post.objects.filter(tit='x')
    Post.objects.filter(title__='x')
    Post.objects.filter(
        author__profile__time='Asia/Seoul',
    )
    AuditLog.objects.filter(na='entry')
    MultiInheritedLog.objects.filter(sl='entry')
    Post.objects.values("author__unknown")
    Post.objects.filter(author__profile__timezone__bogus='Asia/Seoul')
    Post.objects.filter(title__name='x')
    Post.objects.select_related("author__profile__timezone")
    Company.objects.values("corporate_registration__registration_code")
    Company.objects.filter(corporate_registration__registration_code='ABC123')
    Company.objects.filter(st='READY')
    Company.objects.filter(state__rea='READY')
    Company.objects.filter(state__in=['READY'])
    Company.objects.filter(state__ready='READY')


def member_examples():
    audit_log = AuditLog.objects.get(id=1)
    audit_log.

    multi_inherited_log = MultiInheritedLog.objects.get(id=1)
    multi_inherited_log.
