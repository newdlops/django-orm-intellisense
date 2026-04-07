from typing import TYPE_CHECKING

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
