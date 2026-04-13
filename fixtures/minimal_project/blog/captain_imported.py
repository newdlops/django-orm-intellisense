from typing import TypeVar

from django.db import models

__all__ = [
    'CaptainImportedQuestionThread',
    'CaptainImportedQuestionThreadQuerySet',
]

_CaptainImportedThreadT = TypeVar(
    '_CaptainImportedThreadT',
    bound='CaptainImportedQuestionThread',
    covariant=True,
)


class CaptainImportedQuestionThreadQuerySet(models.QuerySet[_CaptainImportedThreadT]):
    pass


class CaptainImportedQuestionThreadManager(models.Manager[_CaptainImportedThreadT]):
    def get_queryset(
        self,
    ) -> CaptainImportedQuestionThreadQuerySet[_CaptainImportedThreadT]:
        return CaptainImportedQuestionThreadQuerySet(self.model, using=self._db)

    def manager_only(
        self,
    ) -> CaptainImportedQuestionThreadQuerySet[_CaptainImportedThreadT]:
        return self.get_queryset()


class CaptainImportedQuestionThread(models.Model):
    company = models.ForeignKey(
        'blog.CaptainImportedCompany',
        related_name='imported_question_thread_set',
        on_delete=models.CASCADE,
    )
    title = models.CharField(max_length=255)
    help_type = models.CharField(max_length=50, default='etc_help')

    objects = CaptainImportedQuestionThreadManager.from_queryset(
        CaptainImportedQuestionThreadQuerySet
    )()
