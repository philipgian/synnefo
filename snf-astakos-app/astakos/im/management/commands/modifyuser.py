# Copyright 2012 GRNET S.A. All rights reserved.
#
# Redistribution and use in source and binary forms, with or
# without modification, are permitted provided that the following
# conditions are met:
#
#   1. Redistributions of source code must retain the above
#      copyright notice, this list of conditions and the following
#      disclaimer.
#
#   2. Redistributions in binary form must reproduce the above
#      copyright notice, this list of conditions and the following
#      disclaimer in the documentation and/or other materials
#      provided with the distribution.
#
# THIS SOFTWARE IS PROVIDED BY GRNET S.A. ``AS IS'' AND ANY EXPRESS
# OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
# WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
# PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL GRNET S.A OR
# CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
# SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
# LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF
# USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED
# AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
# LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN
# ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
# POSSIBILITY OF SUCH DAMAGE.
#
# The views and conclusions contained in the software and
# documentation are those of the authors and should not be
# interpreted as representing official policies, either expressed
# or implied, of GRNET S.A.

from optparse import make_option

from django.core.management.base import BaseCommand, CommandError

from ._common import get_user


class Command(BaseCommand):
    args = "<user ID or email>"
    help = "Modify a user's attributes"
    
    option_list = BaseCommand.option_list + (
        make_option('--invitations',
            dest='invitations',
            metavar='NUM',
            help="Update user's invitations"),
        make_option('--password',
            dest='password',
            metavar='PASSWORD',
            help="Set user's password"),
        make_option('--renew-token',
            action='store_true',
            dest='renew_token',
            default=False,
            help="Renew the user's token"),
        make_option('--set-admin',
            action='store_true',
            dest='admin',
            default=False,
            help="Give user admin rights"),
        make_option('--set-noadmin',
            action='store_true',
            dest='noadmin',
            default=False,
            help="Revoke user's admin rights"),
        make_option('--set-active',
            action='store_true',
            dest='active',
            default=False,
            help="Change user's state to inactive"),
        make_option('--set-inactive',
            action='store_true',
            dest='inactive',
            default=False,
            help="Change user's state to inactive"),
        )
    
    def handle(self, *args, **options):
        if len(args) != 1:
            raise CommandError("Please provide a user ID or email")
        
        user = get_user(args[0])
        if not user:
            raise CommandError("Unknown user")
        
        if options.get('admin'):
            user.is_superuser = True
        elif options.get('noadmin'):
            user.is_superuser = False
        
        if options.get('active'):
            user.is_active = True
        elif options.get('inactive'):
            user.is_active = False
        
        invitations = options.get('invitations')
        if invitations is not None:
            user.invitations = int(invitations)
        
        password = options.get('password')
        if password is not None:
            user.set_password(password)
        
        if options['renew_token']:
            user.renew_token()
        
        user.save()
