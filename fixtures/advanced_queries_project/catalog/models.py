from django.db import models


class Category(models.Model):
    slug = models.SlugField(unique=True)
    title = models.CharField(max_length=128)
