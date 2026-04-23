from django.db import models as db_models
from django.db.models import F, Prefetch, Q

from blog import AuditLog, Company, InheritedOnlyLog, MultiInheritedLog, Post
from blog.models import (
    AppLabelCompany,
    CaptainCompany,
    CompanyQuestionThread,
    CaptainQuestionThread,
    Faq,
    HiddenReverseTag,
    InheritedManagerCompany,
    ProxyRegistrationServiceQuestionThread,
    ProxyCompany,
    QuestionThread,
)


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
    InheritedOnlyLog.objects.filter(cr='entry')
    InheritedOnlyLog.objects.filter(created_at__ye=2024)
    InheritedOnlyLog.objects.filter(created_at__bog='entry')
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
    CompanyQuestionThread.objects.filter(he='inherited')
    CompanyQuestionThread.objects.filter(help_type__i='inherited')
    CompanyQuestionThread.objects.filter(help_type__icontains='inherited')
    CompanyQuestionThread.objects.filter(help_type__bog='inherited')
    ProxyRegistrationServiceQuestionThread.objects.filter(he='proxy')
    ProxyRegistrationServiceQuestionThread.objects.filter(help_type__i='proxy')
    ProxyRegistrationServiceQuestionThread.objects.filter(help_type__icontains='proxy')
    ProxyRegistrationServiceQuestionThread.objects.filter(help_type__bog='proxy')
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
    AppLabelCompany.objects.values("corporate_registration__registration_code")
    AppLabelCompany.objects.filter(corporate_registration__registration_code='ABC123')
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


def create_receiver_examples():
    Post.objects.filter(published=True).create(ti='draft', author_i=1)
    Post.objects.filter(published=True).create(title='draft', bog='x')
    Post.objects.filter(published=True).get_or_create(ti='draft')
    Post.objects.filter(published=True).update_or_create(ti='draft')

    author = Post.objects.get(id=1).author
    author.posts.create(ti='draft')
    author.posts.create(title='draft', bog='x')
    author.posts.get_or_create(ti='draft')
    author.posts.update_or_create(ti='draft')

    company = Company.objects.get(id=1)
    company.question_thread_set.create(ti='draft')
    company.question_thread_set.filter(ti='draft')
    company.question_thread_set.exclude(ti='draft')
    company_question_thread = company.question_thread_set.get(id=1)
    company_question_thread.message_set.create(co='draft')
    company_question_thread.message_set.filter(co='draft')
    company_question_thread.message_set.exclude(co='draft')

    typed_company: Company = Company.objects.get(id=1)
    typed_company.question_thread_set.create()
    typed_company.question_thread_set.create(ti='draft')
    typed_company.question_thread_set.filter(ti='draft')
    typed_company.question_thread_set.exclude(ti='draft')

    typed_question_thread: QuestionThread = QuestionThread.objects.get(id=1)
    typed_question_thread.message_set.create(co='draft')
    typed_question_thread.message_set.filter(co='draft')
    typed_question_thread.message_set.exclude(co='draft')


class CompanyQuestionServiceExamples:
    def __init__(self, company: Company) -> None:
        self.company: "Company" = company

    def method_examples(self):
        self.company.question_thread_set.create(ti='draft')
        self.company.question_thread_set.filter(ti='draft')
        self.company.question_thread_set.exclude(ti='draft')


class MultilineInitServiceExamples:
    def __init__(
        self, *, company: "Company", title: str
    ) -> None:
        self.company: "Company" = company

    def multiline_create_assignment_examples(self):
        company_question_thread = self.company.question_thread_set.create(
            title='test'
        )
        company_question_thread.message_set.create(con='multiline')
        company_question_thread.message_set.filter(con='multiline')
        company_question_thread.message_set.exclude(con='multiline')

    def multiline_self_member_examples(self):
        self.company.question_thread_set.create(ti='multiline_init')
        self.company.question_thread_set.filter(ti='multiline_init')
        self.company.question_thread_set.exclude(ti='multiline_init')


class CaptainCompanyQuestionServiceExamples:
    def __init__(self, company: CaptainCompany) -> None:
        self.company: "CaptainCompany" = company

    def get_company_question_thread(
        self, *, company_question_thread_id: int
    ) -> "CaptainQuestionThread":
        return (
            self.company.question_thread_set.get_queryset()
            .exclude_deleted()
            .get(id=company_question_thread_id)
        )

    def create_company_question_thread(
        self,
        *,
        title: str,
        content: str,
        help_type: str = 'etc_help',
    ) -> "CaptainQuestionThread":
        company_question_thread = self.company.question_thread_set.create(
            title=title,
            help_type=help_type,
        )
        company_question_thread.message_set.create(content=content)
        return company_question_thread

    def method_examples(self):
        self.company.question_thread_set.create()
        self.company.question_thread_set.create(he='captain')
        self.company.mismatched_question_thread_set.create()
        self.company.question_thread_set.filter(he='captain')
        self.company.question_thread_set.exclude(he='captain')
        self.get_company_question_thread(
            company_question_thread_id=1
        ).message_set.create(co='captain')
        self.get_company_question_thread(
            company_question_thread_id=1
        ).message_set.filter(co='captain')
        self.get_company_question_thread(
            company_question_thread_id=1
        ).message_set.exclude(co='captain')

    def update_company_question_thread(
        self, *, company_question_thread_id: int, content: str
    ) -> "CaptainQuestionThreadMessage":
        company_question_thread = (
            self.company.question_thread_set.get_queryset()
            .exclude_deleted()
            .get(id=company_question_thread_id)
        )
        company_question_thread.save(update_fields=["updated_at"])
        message = company_question_thread.message_set.create(
            content=content
        )
        return message

    def multiline_paren_assignment_examples(
        self, *, company_question_thread_id: int
    ):
        company_question_thread = (
            self.company.question_thread_set.get_queryset()
            .exclude_deleted()
            .get(id=company_question_thread_id)
        )
        company_question_thread.me


from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from blog.models import CaptainImportedCompany


class CaptainImportedCompanyQuestionServiceExamples:
    def __init__(self, company: "CaptainImportedCompany") -> None:
        self.company: "CaptainImportedCompany" = company

    def method_examples(self):
        self.company.imported_question_thread_set.create(he='captain_imported')
        self.company.imported_question_thread_set.filter(he='captain_imported')
        self.company.imported_question_thread_set.exclude(he='captain_imported')


class InheritedManagerCompanyQuestionServiceExamples:
    def __init__(self, company: InheritedManagerCompany) -> None:
        self.company: "InheritedManagerCompany" = company

    def method_examples(self):
        self.company.company_question_thread_set.filter(he='inherited')
        self.company.company_question_thread_set.filter(help_type__i='inherited')
        self.company.company_question_thread_set.exclude(he='inherited')

    def create_company_question_thread(
        self,
        *,
        title: str,
        content: str,
        help_type: str = 'etc_help',
    ) -> "CompanyQuestionThread":
        inherited_company_question_thread = (
            self.company.company_question_thread_set.create(
                title=title,
                help_type=help_type,
            )
        )
        inherited_company_question_thread.message_set.create(content=content)
        return inherited_company_question_thread


class ProxyManagerCompanyQuestionServiceExamples:
    def __init__(self, company: ProxyCompany) -> None:
        self.company: "ProxyCompany" = company

    def create_company_question_thread(
        self,
        *,
        title: str,
        content: str,
        help_type: str = 'registration_service',
    ) -> "ProxyCompanyQuestionThread":
        proxy_company_question_thread = self.company.question_thread_set.create(
            title=title,
            help_type=help_type,
        )
        proxy_company_question_thread.message_set.create(content=content)
        return proxy_company_question_thread


def builtin_method_examples():
    post = Post.objects.first()
    post.save()
    post.full_clean()
    post.refresh_from_db()

    qs = Post.objects.filter(published=True)
    qs.union(Post.objects.none())
    qs.difference(Post.objects.all())
    qs.select_for_update()
    qs.explain()


def multiline_nested_expression_examples():
    from django.db.models import Case, Value as V, When

    Company.objects.annotate(
        _label=Case(
            When(
                Q(question_thread_set__is_open=True),
                then=V("open"),
            ),
            When(
                question_thread_set__title="test",
                then=V("test"),
            ),
            default=V("closed"),
        )
    )
    Company.objects.filter(
        Q(question_thread_set__is_open=True)
        | Q(question_thread_set__title__icontains="test"),
        name__icontains="corp",
    )


def multiline_paren_assignment_examples():
    simple_result = (
        Post.objects.get(id=1)
    )
    simple_result.au

    chained_result = (
        Post.objects.filter(published=True)
        .first()
    )
    chained_result.au


def snake_case_variable_name_fallback_examples(context):
    # Variable assigned from unresolvable source — snake_case name matches Company model
    company = context.get_company()
    company.question_thread_set.filter(ti='fallback')
    company.question_thread_set.create(ti='fallback')

    # Multi-word snake_case variable matching QuestionThread model
    question_thread = context.get_thread()
    question_thread.message_set.filter(co='fallback')

    # Reverse relation chain through snake_case fallback
    company_for_chain = context.get_company()
    qt = company_for_chain.question_thread_set.get(id=1)
    qt.message_set.filter(co='chain')
