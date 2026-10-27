"""Query compilation and evaluated prefetch oracle for actual Django relations."""
from __future__ import annotations
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'fixtures/minimal_project'))
os.environ['DJANGO_SETTINGS_MODULE'] = 'project.settings'
import django
django.setup()
from django.apps import apps
from django.db import connection
from blog.models import Author, Post, QuestionThread
from django_orm_intellisense.features.lookup_paths import resolve_lookup_path, list_lookup_path_completions
from django_orm_intellisense.runtime.inspector import inspect_runtime
from django_orm_intellisense.semantic.graph import build_model_graph
from django_orm_intellisense.static_index.indexer import StaticIndex

with connection.schema_editor() as editor:
    for model in apps.get_models():
        if model._meta.can_migrate(connection) and model.__name__ != 'SchemaExample':
            editor.create_model(model)
Author.objects.create(name='Ada')
runtime = inspect_runtime('project.settings')
graph = build_model_graph(StaticIndex(0, 0, 0, 0, 0, {}, []), runtime)
surface = {}
for model in runtime.model_catalog:
    surface[model.label] = {'instance': {
        field.name: ['related_manager' if field.is_relation and 'Many' in field.field_kind else
                     'instance' if field.is_relation else 'scalar', field.related_model_label,
                     'reverse_relation' if field.relation_direction == 'reverse' else
                     'relation' if field.is_relation else 'field', field.field_kind]
        for field in graph.fields_for_model(model.label)
    }}
cases = [(Post, 'author'), (Post, 'tags'), (Post, 'author__profile'), (Post, 'tags__posts'),
         (Author, 'posts'), (Author, 'profile'), (Author, 'profile__author'),
         (Author, 'mentor__mentees'), (QuestionThread, 'tmeta'), (QuestionThread, '_tmeta')]
oracle = []
for model, path in cases:
    for method in ('select_related', 'prefetch_related', 'only', 'defer'):
        try:
            query = getattr(model.objects, method)(path)
            str(query.query)
            if method == 'prefetch_related':
                # A row forces descriptor validation even when the relation is empty.
                if model is QuestionThread:
                    instance = model(pk=1)
                    from django.db.models import prefetch_related_objects
                    prefetch_related_objects([instance], path)
                elif model is Post:
                    instance = model(pk=1, author_id=1)
                    from django.db.models import prefetch_related_objects
                    prefetch_related_objects([instance], path)
                else:
                    list(query)
            accepted = True
        except (django.core.exceptions.FieldError, django.core.exceptions.FieldDoesNotExist, AttributeError, ValueError):
            accepted = False
        result = resolve_lookup_path(model_graph=graph, runtime=runtime, base_model_label=model._meta.label,
                                     path=path, method=method)
        assert result['resolved'] == accepted, (model.__name__, method, path, accepted, result)
        oracle.append({'model': model._meta.label, 'path': path, 'method': method, 'resolved': accepted})
for model, method, present, absent in [(Post, 'select_related', 'author', 'tags'),
                                      (Post, 'prefetch_related', 'tags', 'title'),
                                      (QuestionThread, 'select_related', 'tmeta', '_tmeta'),
                                      (QuestionThread, 'prefetch_related', '_tmeta', 'tmeta')]:
    names = {item['name'] for item in list_lookup_path_completions(model_graph=graph, runtime=runtime,
             base_model_label=model._meta.label, prefix='', method=method)['items']}
    assert present in names and absent not in names, (method, names)
print(json.dumps({'surfaceIndex': surface, 'lookupCatalog': runtime.lookup_catalog,
                  'djangoVersion': runtime.django_version, 'oracleCases': oracle}))
