#!/usr/bin/env python
# -*- coding: utf-8 -*-
#
# Copyright 2011 GRNET S.A. All rights reserved.
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
#

"""Ganeti notification daemon with AMQP support

A daemon to monitor the Ganeti job queue and publish job progress
and Ganeti VM state notifications to the ganeti exchange
"""

import sys
import os
path = os.path.normpath(os.path.join(os.getcwd(), '..'))
sys.path.append(path)

import json
import logging
import pyinotify
import daemon
import daemon.pidlockfile
import socket
from signal import signal, SIGINT, SIGTERM

from ganeti import utils
from ganeti import jqueue
from ganeti import constants
from ganeti import serializer

from synnefo import settings
from synnefo.lib.amqp import AMQPClient

def get_time_from_status(op, job):
    """Generate a unique message identifier for a ganeti job.

    The identifier is based on the timestamp of the job. Since a ganeti
    job passes from multiple states, we need to pick the timestamp that
    corresponds to each state.

    """
    status = op.status
    if status == constants.JOB_STATUS_QUEUED:
        return job.received_timestamp
    if status == constants.JOB_STATUS_WAITLOCK:
    #if status == constants.JOB_STATUS_WAITING:
        return op.start_timestamp
    if status == constants.JOB_STATUS_CANCELING:
        return op.start_timestamp
    if status == constants.JOB_STATUS_RUNNING:
        return op.exec_timestamp
    if status in constants.JOBS_FINALIZED:
        # success, canceled, error
        return op.end_timestamp

    raise InvalidBackendState(status, job)


class InvalidBackendStatus(Exception):
    def __init__(self, status, job):
        self.status = status
        self.job = job

    def __str__(self):
        return repr("Invalid backend status: %s in job %s"
                    % (self.status, self.job))


class JobFileHandler(pyinotify.ProcessEvent):
    def __init__(self, logger):
        pyinotify.ProcessEvent.__init__(self)
        self.logger = logger
        self.client = AMQPClient()
        handler_logger.info("Attempting to connect to RabbitMQ hosts")
        self.client.connect()
        handler_logger.info("Connected succesfully")

    def process_IN_CLOSE_WRITE(self, event):
        self.process_IN_MOVED_TO(event)

    def process_IN_MOVED_TO(self, event):
        jobfile = os.path.join(event.path, event.name)
        if not event.name.startswith("job-"):
            self.logger.debug("Not a job file: %s" % event.path)
            return

        try:
            data = utils.ReadFile(jobfile)
        except IOError:
            return

        data = serializer.LoadJson(data)
        try: # Version compatibility issue with Ganeti
            job = jqueue._QueuedJob.Restore(None, data, False)
        except TypeError:
            job = jqueue._QueuedJob.Restore(None, data)


        for op in job.ops:
            instances = ""
            try:
                instances = " ".join(op.input.instances)
            except AttributeError:
                pass

            try:
                instances = op.input.instance_name
            except AttributeError:
                pass

            # Get the last line of the op log as message
            try:
                logmsg = op.log[-1][-1]
            except IndexError:
                logmsg = None

            # Generate a unique message identifier
            event_time = get_time_from_status(op, job)

            self.logger.debug("Job: %d: %s(%s) %s %s",
                    int(job.id), op.input.OP_ID, instances, op.status, logmsg)

            # Construct message
            msg = {
                    "event_time" : event_time,
                    "type": "ganeti-op-status",
                    "instance": instances,
                    "operation": op.input.OP_ID,
                    "jobId": int(job.id),
                    "status": op.status,
                    "logmsg": logmsg
                    }

            instance_prefix = instances.split('-')[0]
            routekey = "ganeti.%s.event.op" % instance_prefix

            self.logger.debug("Delivering msg: %s (key=%s)", json.dumps(msg),
                              routekey)
            msg = json.dumps(msg)

            # Send the message to RabbitMQ
            self.client.basic_publish(exchange=settings.EXCHANGE_GANETI,
                                      routing_key=routekey,
                                      body=msg)

handler_logger = None
def fatal_signal_handler(signum, frame):
    global handler_logger

    handler_logger.info("Caught fatal signal %d, will raise SystemExit",
                        signum)
    raise SystemExit

def parse_arguments(args):
    from optparse import OptionParser

    parser = OptionParser()
    parser.add_option("-d", "--debug", action="store_true", dest="debug",
                      help="Enable debugging information")
    parser.add_option("-l", "--log", dest="log_file",
                      default="/var/log/snf-ganeti-eventd.log",
                      metavar="FILE",
                      help="Write log to FILE instead of %s" %
                          "/var/log/snf-ganeti-eventd.log")
    parser.add_option('--pid-file', dest="pid_file",
                      default="/var/run/snf-ganeti-eventd.pid",
                      metavar='PIDFILE',
                      help="Save PID to file (default: %s)" %
                          "/var/run/snf-ganeti-eventd.pid")

    return parser.parse_args(args)

def main():
    global handler_logger

    (opts, args) = parse_arguments(sys.argv[1:])

    # Create pidfile
    pidf = daemon.pidlockfile.TimeoutPIDLockFile(opts.pid_file, 10)

    # Initialize logger
    lvl = logging.DEBUG if opts.debug else logging.INFO
    logger = logging.getLogger("ganeti.eventd")
    logger.setLevel(lvl)
    formatter = logging.Formatter(
        "%(asctime)s %(module)s[%(process)d] %(levelname)s: %(message)s",
        "%Y-%m-%d %H:%M:%S")
    handler = logging.FileHandler(opts.log_file)
    handler.setFormatter(formatter)
    logger.addHandler(handler)
    handler_logger = logger

    # Become a daemon:
    # Redirect stdout and stderr to handler.stream to catch
    # early errors in the daemonization process [e.g., pidfile creation]
    # which will otherwise go to /dev/null.
    daemon_context = daemon.DaemonContext(
            pidfile=pidf,
            umask=022,
            stdout=handler.stream,
            stderr=handler.stream,
            files_preserve=[handler.stream])
    daemon_context.open()
    logger.info("Became a daemon")

    # Catch signals to ensure graceful shutdown
    signal(SIGINT, fatal_signal_handler)
    signal(SIGTERM, fatal_signal_handler)

    # Monitor the Ganeti job queue, create and push notifications
    wm = pyinotify.WatchManager()
    mask = pyinotify.EventsCodes.ALL_FLAGS["IN_MOVED_TO"] | \
           pyinotify.EventsCodes.ALL_FLAGS["IN_CLOSE_WRITE"]
    handler = JobFileHandler(logger)
    notifier = pyinotify.Notifier(wm, handler)

    try:
        # Fail if adding the inotify() watch fails for any reason
        res = wm.add_watch(constants.QUEUE_DIR, mask)
        if res[constants.QUEUE_DIR] < 0:
            raise Exception("pyinotify add_watch returned negative descriptor")

        logger.info("Now watching %s" % constants.QUEUE_DIR)

        while True:    # loop forever
            # process the queue of events as explained above
            notifier.process_events()
            if notifier.check_events():
                # read notified events and enqeue them
                notifier.read_events()
    except SystemExit:
        logger.info("SystemExit")
    except:
        logger.exception("Caught exception, terminating")
    finally:
        # destroy the inotify's instance on this interrupt (stop monitoring)
        notifier.stop()
        raise

if __name__ == "__main__":
    sys.exit(main())

# vim: set sta sts=4 shiftwidth=4 sw=4 et ai :
