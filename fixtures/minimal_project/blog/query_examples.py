from blog import AuditLog, Company, MultiInheritedLog, Post


def lookup_examples():
    Post.objects.values("author__pro")
    Post.objects.values("author__profile__timezone")
    Post.objects.select_related("author__profile")
    Post.objects.order_by("author__name")
    Post.objects.filter(author__pro='mentor')
    Post.objects.filter(author__profile__timezone='Asia/Seoul')
    Post.objects.filter(author__profile__timezone__i='Asia/Seoul')
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
