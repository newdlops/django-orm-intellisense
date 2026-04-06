from django.db import models as db_models
from django.db.models import F, Prefetch, Q

from blog import AuditLog, Company, MultiInheritedLog, Post
from blog.models import Faq, HiddenReverseTag


def lookup_examples():
    Post.objects.values("author__pro")
    Post.objects.values("author__")
    Post.objects.values("author__profile__timezone")
    Post.objects.values_list("author__pro")
    Post.objects.values_list("author__profile__timezone")
    Post.objects.select_related("author__profile")
    Post.objects.prefetch_related("author__pro")
    Post.objects.prefetch_related("author__profile")
    Post.objects.prefetch_related("author__profile__timezone")
    Post.objects.prefetch_related(Prefetch("author__pro"))
    Post.objects.prefetch_related(Prefetch("author__profile"))
    Post.objects.prefetch_related(Prefetch("author__profile__timezone"))
    Post.objects.only("author__na")
    Post.objects.defer("author__na")
    Post.objects.order_by("author__name")
    Post.objects.filter(auth='mentor')
    Post.objects.filter()
    Post.objects.filter(author__pro='mentor')
    Post.objects.filter(author__='mentor')
    Post.objects.filter(author__profile__timezone='Asia/Seoul')
    Post.objects.filter(author__profile__timezone__='Asia/Seoul')
    Post.objects.filter(author__profile__timezone__i='Asia/Seoul')
    Post.objects.filter(p=1)
    Post.objects.filter(pk=1)
    Post.objects.filter(pk__i=[1, 2])
    Post.objects.filter(author__p=1)
    Post.objects.filter(author__pk=1)
    Post.objects.filter(author__pk__i=[1, 2])
    Post.objects.filter(author_i=1)
    Post.objects.filter(author_id__in=[1, 2])
    Post.objects.filter(Q(author__pro='mentor'))
    Post.objects.filter(Q(author__profile__timezone='Asia/Seoul'))
    Post.objects.get(Q(author__pro='mentor'))
    Post.objects.get_or_create(author__pro='mentor')
    Post.objects.update_or_create(author__pro='mentor')
    Post.objects.exclude(db_models.Q(author__pro='mentor'))
    Post.objects.exclude(db_models.Q(author__profile__timezone='Asia/Seoul'))
    Post.objects.create(ti='draft', author_i=1)
    Post.objects.update(ti='draft', author_i=1)
    Post.objects.create(title='draft', bog='x')
    Post.objects.update(title='draft', bog='x')
    Post.objects.filter(tit='x')
    Post.objects.filter(title__='x')
    Post.objects.filter(title=F("author__na"))
    Post.objects.filter(title=F("author__profile__timezone"))
    Post.objects.exclude(title=db_models.F("author__na"))
    Post.objects.filter(
        author__profile__time='Asia/Seoul',
    )
    AuditLog.objects.filter(na='entry')
    AuditLog.objects.exclude(Q(na='entry'))
    MultiInheritedLog.objects.filter(sl='entry')
    Faq.objects.filter(ti='faq')
    Faq.objects.filter(title='faq')
    Faq.objects.filter(li='faq')
    Faq.objects.filter(link__la='faq')
    Faq.objects.filter(link__label='faq')
    Faq.objects.prefetch_related("li")
    Faq.objects.prefetch_related("link")
    Faq.objects.prefetch_related("link_set")
    Company.objects.exclude(db_models.Q(st='READY'))
    Company.objects.get(name=db_models.F("st"))
    Post.objects.values("author__unknown")
    Post.objects.filter(author__profile__timezone__bogus='Asia/Seoul')
    Post.objects.filter(title__name='x')
    Post.objects.filter(Q(title__name='x'))
    Post.objects.exclude(db_models.Q(title__name='x'))
    Post.objects.filter(title=F("title__name"))
    Post.objects.get(title=db_models.F("title__name"))
    Post.objects.exclude(db_models.Q(author__profile__timezone__bogus_q='Asia/Seoul'))
    Post.objects.get(title=db_models.F("author__profile__timezone__bogus_f"))
    Post.objects.select_related("author__profile__timezone")
    Company.objects.values("corporate_registration__registration_code")
    Company.objects.filter(corporate_registration__registration_code='ABC123')
    Company.objects.filter(st='READY')
    Company.objects.filter(state__rea='READY')
    Company.objects.filter(state__in=['READY'])
    Company.objects.filter(state__ready='READY')
    HiddenReverseTag.objects.filter(_b='hidden')
    HiddenReverseTag.objects.filter(_blog_hiddenreversepost_tags_+__i=['hidden'])


def member_examples():
    audit_log = AuditLog.objects.get(id=1)
    audit_log.

    multi_inherited_log = MultiInheritedLog.objects.get(id=1)
    multi_inherited_log.


def write_result_examples(post: Post):
    created_post = Post.objects.create(title='draft', author_id=1)
    created_post.au

    found_post, was_created = Post.objects.get_or_create(title='draft', author_id=1)
    found_post.au

    updated_post, was_updated = Post.objects.update_or_create(title='draft', author_id=1)
    updated_post.au

    created_posts = Post.objects.bulk_create([Post(title='draft', author_id=1)])
    for created_bulk_post in created_posts:
        created_bulk_post.au

    Post.objects.bulk_update([post], ["tit"])
    Post.objects.bulk_update([post], ["title"])
    Post.objects.bulk_update([post], ["bog"])
