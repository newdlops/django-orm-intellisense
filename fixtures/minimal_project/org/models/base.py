from django.db import models


class VendorBase(models.Model):
    created_by = models.ForeignKey(
        'blog.Author',
        related_name='vendors',
        on_delete=models.CASCADE,
    )

    class Meta:
        abstract = True
