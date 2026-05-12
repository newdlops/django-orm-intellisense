"""Fixture exercising reverse-manager (`<instance>.<X>_set`) lookups across
several patterns the daemon's static index must enumerate correctly:

  * Same-app FK reverse with explicit `related_name`:
      Post.author → Author.posts (related_name='posts')
  * Cross-app FK reverse declared on an abstract base, inherited by a
    concrete subclass: VendorBase.created_by (FK to blog.Author) →
    Author.vendors. The reverse generator must see Vendor (concrete) as
    a source candidate even though the FK lives on VendorBase (abstract).
  * Self-referential FK reverse: Author.mentor (FK to 'self') →
    Author.mentees (related_name='mentees').
  * OneToOne reverse: Profile.author → Author.profile (related_name='profile').
  * M2M reverse: Post.tags (M2M to Tag) → Tag.posts (related_name='posts').

Production trace from captain workspace showed `<instance>.<X>_set` patterns
landing in noRecv even when the parent model existed in the graph. This
fixture validates that reverse-accessor enumeration covers the realistic
mix of inheritance, cross-app, self-ref, and M2M shapes.
"""
from blog import Author, Post, Tag
from blog.models import QuestionThread, Faq


def reverse_accessor_lookups(author: Author):
    author.posts.filter(title__contains="a")
    author.posts.exclude(title__startswith="_")
    author.posts.filter(published=True)
    author.mentees.filter(name__contains="b")
    author.mentees.exclude(name__startswith="_")
    author.profile.timezone = "UTC"
    author.vendors.filter(name__contains="c")
    author.vendors.exclude(name__startswith="_")


def tag_reverse_lookups(tag: Tag):
    tag.posts.filter(title__contains="d")
    tag.posts.filter(published=True)
    tag.posts.exclude(title__startswith="_")


def implicit_reverse_name_lookups(question_thread: QuestionThread):
    # Message.question_thread = FK(QuestionThread) WITHOUT explicit
    # related_name. Default Django reverse name is `message_set` (lowercase
    # source model name + `_set`). This exercises the
    # `_default_reverse_name` code path of the static indexer.
    question_thread.message_set.filter(content__contains="e")
    question_thread.message_set.exclude(is_visible=False)


def custom_related_name_lookups(faq: Faq):
    # FaqLink.faq = ParentalKey(to=Faq, related_name='link_set'). The
    # `related_name` uses an explicit underscore-style accessor —
    # production captain trace shows similar `<X>_set` patterns failing
    # to enumerate. Verify this canonical shape resolves.
    faq.link_set.filter(label__contains="f")
    faq.link_set.exclude(label__startswith="_")


def post_forward_lookups(post: Post):
    post.author.name = "x"
    post.tags.add(Tag())
