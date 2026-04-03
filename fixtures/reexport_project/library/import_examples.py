from library import Book, Shelf


def import_examples():
    Book.objects.filter(ti='x')
    return Book, Shelf
