SECRET_KEY = 'fixture-secret-key'
DEBUG = True
ROOT_URLCONF = 'project.urls'
USE_TZ = True
ALLOWED_HOSTS = ['*']
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

INSTALLED_APPS = [
    'django.contrib.contenttypes',
    'django.contrib.auth',
    'blog',
]

DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.sqlite3',
        'NAME': ':memory:',
    }
}

MIDDLEWARE = []

TEMPLATES = []
