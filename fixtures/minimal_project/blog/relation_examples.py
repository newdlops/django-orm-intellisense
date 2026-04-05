from django.db import models

ParentalKey = models.ForeignKey


def relation_examples():
    models.ForeignKey("blog.Aut", on_delete=models.CASCADE)
    models.ForeignKey(to="blog.Aut", on_delete=models.CASCADE)
    models.ForeignKey("blog.Profile", on_delete=models.CASCADE)
    models.ForeignKey("Profile", on_delete=models.CASCADE)
    models.OneToOneField("blog.Profile", on_delete=models.CASCADE)
    models.ManyToManyField("blog.Ta")
    ParentalKey(to="blog.Fa", on_delete=models.CASCADE)
    ParentalKey(to="blog.Faq", on_delete=models.CASCADE)
    models.ForeignKey("blog.UnknownModel", on_delete=models.CASCADE)
