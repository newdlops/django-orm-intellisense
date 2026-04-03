from django.db import models


class Book(models.Model):
    title = models.CharField(max_length=255)


class Shelf(models.Model):
    name = models.CharField(max_length=64)
    books = models.ManyToManyField('library.Book', related_name='shelves')
