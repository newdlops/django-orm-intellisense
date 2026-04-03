from django.db import models


class TimeStampedBaseModel(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)

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


class Post(models.Model):
    author = models.ForeignKey(
        Author,
        related_name='posts',
        on_delete=models.CASCADE,
    )
    tags = models.ManyToManyField('blog.Tag', related_name='posts')
    title = models.CharField(max_length=255)
    published = models.BooleanField(default=False)


class AuditLog(TimeStampedBaseModel):
    name = models.CharField(max_length=255)
    note = models.TextField(blank=True)
