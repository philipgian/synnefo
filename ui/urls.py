from django.conf.urls.defaults import *
import os

urlpatterns = patterns('',
    (r'^$', 'synnefo.ui.views.home'),
    (r'^machines$', 'synnefo.ui.views.machines'),
    (r'^machines/list$', 'synnefo.ui.views.machines_list'),
    (r'^disks$', 'synnefo.ui.views.disks'),
    (r'^images$', 'synnefo.ui.views.images'),
    (r'^networks$', 'synnefo.ui.views.networks'),
    (r'^static/(.*)$', 'django.views.static.serve', {'document_root': os.path.join(os.path.dirname(__file__),'static')}),
)

