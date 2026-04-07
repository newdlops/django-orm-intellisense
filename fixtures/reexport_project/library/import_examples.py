from library import Book, Shelf
from .models import Book as DirectBook
from .models import (
    Book as MultiLineBook,
    Shelf as MultiLineShelf,
)
from . import models as relative_models
import library.models as library_models


def import_examples():
    Book.objects.filter(ti='x')
    return Book, Shelf


def module_import_examples():
    DirectBook.objects.filter(ti='x')
    return relative_models.Book, library_models.Shelf


def multiline_import_examples():
    MultiLineBook.objects.filter(ti='x')
    return MultiLineBook, MultiLineShelf
