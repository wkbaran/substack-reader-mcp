#!/bin/sh
# Cron pre-run script for the substack-digest skill. Its output is added to the top of the
# agent's prompt. Since skill v3 the server records the run's start time itself
# (digest_begin), so this only tells the model today's date.
date -u +"Today's real date is %Y-%m-%d (%A), UTC."
