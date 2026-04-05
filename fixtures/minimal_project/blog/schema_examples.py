from django.db import models
from django.db.models import Q

from blog.models import Author


class SchemaExample(models.Model):
    code = models.CharField(max_length=32)
    author = models.ForeignKey(Author, on_delete=models.CASCADE)
    published = models.BooleanField(default=False)

    class Meta:
        indexes = [
            models.Index(fields=['co'], name='schema_example_code_idx'),
            models.Index(fields=['author', 'pub'], name='schema_example_author_published_idx'),
            models.Index(fields=['bog'], name='schema_example_bog_idx'),
        ]
        constraints = [
            models.UniqueConstraint(fields=['code', 'author'], name='schema_example_code_author_uniq'),
            models.UniqueConstraint(fields=['bog'], name='schema_example_bog_uniq'),
            models.UniqueConstraint(
                fields=['author'],
                name='schema_example_author_if_unpublished',
                condition=models.Q(pub=False),
            ),
            models.CheckConstraint(
                check=Q(author__na__gt=''),
                name='schema_example_author_name_partial',
            ),
            models.CheckConstraint(
                check=Q(author__name__gt=''),
                name='schema_example_author_name_not_empty',
            ),
            models.CheckConstraint(
                check=models.Q(author__profile__bogus__isnull=True),
                name='schema_example_author_profile_bogus',
            ),
        ]
