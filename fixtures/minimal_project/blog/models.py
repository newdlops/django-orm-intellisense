from typing import TYPE_CHECKING, TypeVar

from django.db import models
from django.db.models.lookups import Lookup

COMPANY_REGISTRATION_RELATED_NAME = 'corporate_registration'


class TimeStampedBaseModel(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        abstract = True


class SluggedBaseModel(models.Model):
    slug = models.SlugField(max_length=64)

    class Meta:
        abstract = True


class Author(models.Model):
    name = models.CharField(max_length=128)
    mentor = models.ForeignKey(
        'self',
        null=True,
        blank=True,
        related_name='mentees',
        on_delete=models.SET_NULL,
    )


class Profile(models.Model):
    author = models.OneToOneField(
        'blog.Author',
        related_name='profile',
        on_delete=models.CASCADE,
    )
    timezone = models.CharField(max_length=64)


class Tag(models.Model):
    label = models.CharField(max_length=64)


class HiddenReverseTag(models.Model):
    label = models.CharField(max_length=64)


class Status(models.CharField):
    pass


class ReadyLookup(Lookup):
    lookup_name = 'ready'

    def as_sql(self, compiler, connection):
        lhs, lhs_params = self.process_lhs(compiler, connection)
        rhs, rhs_params = self.process_rhs(compiler, connection)
        return f'{lhs} = {rhs}', [*lhs_params, *rhs_params]


Status.register_lookup(ReadyLookup)


class Post(models.Model):
    author = models.ForeignKey(
        Author,
        related_name='posts',
        on_delete=models.CASCADE,
    )
    tags = models.ManyToManyField('blog.Tag', related_name='posts')
    title = models.CharField(max_length=255)
    published = models.BooleanField(default=False)


class HiddenReversePost(models.Model):
    tags = models.ManyToManyField('blog.HiddenReverseTag', related_name='+')
    title = models.CharField(max_length=255)


class Company(models.Model):
    if TYPE_CHECKING:
        question_thread_set: "QuestionThreadManager[QuestionThread]"

    name = models.CharField(max_length=255)
    state = Status(max_length=32)


class QuestionThreadQuerySet(models.QuerySet["QuestionThread"]):
    def open_only(self) -> "QuestionThreadQuerySet":
        return self.filter(is_open=True)


class QuestionThreadManager(models.Manager.from_queryset(QuestionThreadQuerySet)):
    pass


class QuestionThread(models.Model):
    company = models.ForeignKey(
        Company,
        related_name='question_thread_set',
        on_delete=models.CASCADE,
    )
    title = models.CharField(max_length=255)
    is_open = models.BooleanField(default=True)

    objects = QuestionThreadManager()


class Message(models.Model):
    question_thread = models.ForeignKey(
        QuestionThread,
        on_delete=models.CASCADE,
    )
    content = models.CharField(max_length=255)
    is_visible = models.BooleanField(default=True)


class CorporateRegistration(models.Model):
    company = models.OneToOneField(
        Company,
        related_name=COMPANY_REGISTRATION_RELATED_NAME,
        on_delete=models.CASCADE,
    )
    registration_code = models.CharField(max_length=64)


class AuditLog(TimeStampedBaseModel):
    name = models.CharField(max_length=255)
    note = models.TextField(blank=True)


class MultiInheritedLog(TimeStampedBaseModel, SluggedBaseModel):
    title = models.CharField(max_length=255)


ParentalKey = models.ForeignKey


class TimestampedModel(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        abstract = True


class Faq(TimestampedModel):
    title = models.CharField(max_length=255)


class FaqLink(TimestampedModel):
    faq = ParentalKey(
        to=Faq,
        related_name='link_set',
        related_query_name='link',
        on_delete=models.CASCADE,
    )
    label = models.CharField(max_length=255)


class AppLabelCompany(models.Model):
    name = models.CharField(max_length=255)

    @property
    def corporate_registration(self) -> "AppLabelCorporateRegistration | None":
        return self.corporate_registration_at(__import__('datetime').date.today())

    def corporate_registration_at(self, date) -> "AppLabelCorporateRegistration | None":
        return self.app_label_corporate_registration_set.filter(
            issue_date__lte=date
        ).order_by('-issue_date').first()

    class Meta:
        app_label = 'db'


class AppLabelCorporateRegistration(models.Model):
    company = models.ForeignKey(
        AppLabelCompany,
        related_name='app_label_corporate_registration_set',
        related_query_name='corporate_registration',
        on_delete=models.CASCADE,
    )
    registration_code = models.CharField(max_length=64)
    issue_date = models.DateField(default=__import__('datetime').date(2999, 12, 31))

    class Meta:
        app_label = 'db'


_CaptainThreadT = TypeVar(
    '_CaptainThreadT',
    bound='CaptainQuestionThread',
    covariant=True,
)
_CaptainMessageT = TypeVar(
    '_CaptainMessageT',
    bound='CaptainQuestionThreadMessage',
    covariant=True,
)


class DeletedQuerySetMixin:
    def exclude_deleted(self):
        return self.exclude(is_deleted=True)


class CaptainQuestionThreadQuerySet(
    DeletedQuerySetMixin,
    models.QuerySet[_CaptainThreadT],
):
    pass


class CaptainQuestionThreadManager(models.Manager[_CaptainThreadT]):
    def get_queryset(self) -> CaptainQuestionThreadQuerySet[_CaptainThreadT]:
        return CaptainQuestionThreadQuerySet(self.model, using=self._db)

    def manager_only(self) -> CaptainQuestionThreadQuerySet[_CaptainThreadT]:
        return self.get_queryset()


class CaptainQuestionThreadMessageQuerySet(
    DeletedQuerySetMixin,
    models.QuerySet[_CaptainMessageT],
):
    pass


class CaptainQuestionThreadMessageManager(models.Manager[_CaptainMessageT]):
    def get_queryset(self) -> CaptainQuestionThreadMessageQuerySet[_CaptainMessageT]:
        return CaptainQuestionThreadMessageQuerySet(self.model, using=self._db)


class CaptainMisleadingQuestionThreadManager(
    models.Manager["CaptainMisleadingQuestionThread"],
):
    def misleading_only(self) -> "CaptainMisleadingQuestionThreadManager":
        return self


class CaptainCompany(models.Model):
    if TYPE_CHECKING:
        question_thread_set: 'CaptainQuestionThreadManager'
        mismatched_question_thread_set: 'CaptainMisleadingQuestionThreadManager'

    name = models.CharField(max_length=255)


class CaptainMisleadingQuestionThread(models.Model):
    misleading_only = models.CharField(max_length=255)


class CaptainActualQuestionThread(models.Model):
    company = models.ForeignKey(
        CaptainCompany,
        related_name='mismatched_question_thread_set',
        on_delete=models.CASCADE,
    )
    actual_only = models.CharField(max_length=255)


class CaptainQuestionThread(models.Model):
    if TYPE_CHECKING:
        message_set: 'CaptainQuestionThreadMessageManager'

    company = models.ForeignKey(
        CaptainCompany,
        related_name='question_thread_set',
        on_delete=models.CASCADE,
    )
    title = models.CharField(max_length=255)
    help_type = models.CharField(max_length=50, default='etc_help')
    is_deleted = models.BooleanField(default=False)

    objects = CaptainQuestionThreadManager.from_queryset(
        CaptainQuestionThreadQuerySet
    )()


class CaptainQuestionThreadMessage(models.Model):
    question_thread = models.ForeignKey(
        CaptainQuestionThread,
        related_name='message_set',
        on_delete=models.CASCADE,
    )
    content = models.CharField(max_length=255)
    is_deleted = models.BooleanField(default=False)

    objects = CaptainQuestionThreadMessageManager.from_queryset(
        CaptainQuestionThreadMessageQuerySet
    )()


if TYPE_CHECKING:
    from .captain_imported import CaptainImportedQuestionThreadManager


class CaptainImportedCompany(  # type: ignore[django-manager-missing]
    models.Model,
):
    if TYPE_CHECKING:
        imported_question_thread_set: 'CaptainImportedQuestionThreadManager'

    name = models.CharField(max_length=255)


class RegistrationServiceQuestionThread(models.Model):
    title = models.CharField(max_length=255)
    help_type = models.CharField(max_length=50, default='etc_help')


class RegistrationServiceQuestionThreadManager(
    models.Manager["RegistrationServiceQuestionThread"],
):
    pass


class CompanyQuestionThreadManager(RegistrationServiceQuestionThreadManager):
    pass


class InheritedManagerCompany(models.Model):
    if TYPE_CHECKING:
        company_question_thread_set: 'CompanyQuestionThreadManager'

    name = models.CharField(max_length=255)


class CompanyQuestionThread(RegistrationServiceQuestionThread):
    company = models.ForeignKey(
        InheritedManagerCompany,
        related_name='company_question_thread_set',
        on_delete=models.CASCADE,
    )

    objects = CompanyQuestionThreadManager()


class CompanyQuestionThreadMessage(models.Model):
    question_thread = models.ForeignKey(
        RegistrationServiceQuestionThread,
        related_name='message_set',
        on_delete=models.CASCADE,
    )
    content = models.CharField(max_length=255)


_ProxyCompanyQuestionThreadT = TypeVar(
    '_ProxyCompanyQuestionThreadT',
    bound='ProxyCompanyQuestionThread',
    covariant=True,
)
_ProxyCompanyQuestionThreadMessageT = TypeVar(
    '_ProxyCompanyQuestionThreadMessageT',
    bound='ProxyCompanyQuestionThreadMessage',
    covariant=True,
)


class ProxyCompanyQuestionThreadQuerySet(
    models.QuerySet[_ProxyCompanyQuestionThreadT],
):
    pass


class ProxyCompanyQuestionThreadManager(
    models.Manager[_ProxyCompanyQuestionThreadT],
):
    def get_queryset(self) -> ProxyCompanyQuestionThreadQuerySet[_ProxyCompanyQuestionThreadT]:
        return ProxyCompanyQuestionThreadQuerySet(self.model, using=self._db)


class ProxyRegistrationServiceQuestionThreadManager(
    models.Manager["ProxyCompanyQuestionThread"],
):
    def get_queryset(self) -> ProxyCompanyQuestionThreadQuerySet["ProxyCompanyQuestionThread"]:
        return ProxyCompanyQuestionThreadQuerySet(self.model, using=self._db).filter(
            help_type='registration_service'
        )


class ProxyCompany(models.Model):
    if TYPE_CHECKING:
        question_thread_set: 'ProxyCompanyQuestionThreadManager'

    name = models.CharField(max_length=255)


class ProxyCompanyQuestionThread(models.Model):
    if TYPE_CHECKING:
        message_set: 'ProxyCompanyQuestionThreadMessageManager'

    company = models.ForeignKey(
        ProxyCompany,
        related_name='question_thread_set',
        on_delete=models.CASCADE,
    )
    title = models.CharField(max_length=255)
    help_type = models.CharField(max_length=50, default='etc_help')

    objects = ProxyCompanyQuestionThreadManager.from_queryset(
        ProxyCompanyQuestionThreadQuerySet
    )()


class ProxyRegistrationServiceQuestionThread(ProxyCompanyQuestionThread):
    objects = ProxyRegistrationServiceQuestionThreadManager.from_queryset(
        ProxyCompanyQuestionThreadQuerySet
    )()

    class Meta:
        proxy = True


class ProxyCompanyQuestionThreadMessageQuerySet(
    models.QuerySet[_ProxyCompanyQuestionThreadMessageT],
):
    pass


class ProxyCompanyQuestionThreadMessageManager(
    models.Manager[_ProxyCompanyQuestionThreadMessageT],
):
    def get_queryset(
        self,
    ) -> ProxyCompanyQuestionThreadMessageQuerySet[_ProxyCompanyQuestionThreadMessageT]:
        return ProxyCompanyQuestionThreadMessageQuerySet(self.model, using=self._db)


class ProxyCompanyQuestionThreadMessage(models.Model):
    question_thread = models.ForeignKey(
        ProxyCompanyQuestionThread,
        related_name='message_set',
        on_delete=models.CASCADE,
    )
    content = models.CharField(max_length=255)

    objects = ProxyCompanyQuestionThreadMessageManager.from_queryset(
        ProxyCompanyQuestionThreadMessageQuerySet
    )()


# Ensure Django discovers models defined in separate modules within this app.
from blog.schema_examples import SchemaExample as SchemaExample  # noqa: F401,E402
