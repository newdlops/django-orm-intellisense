from django.db import models


def relation_examples():
    models.ForeignKey("blog.Aut", on_delete=models.CASCADE)
    models.OneToOneField("blog.Profile", on_delete=models.CASCADE)
    models.ManyToManyField("blog.Ta")
    models.ForeignKey("blog.UnknownModel", on_delete=models.CASCADE)
