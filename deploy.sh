#!/bin/bash
set -e

MSG="${1:-deploy}"

git add -A
git commit -m "$MSG

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
git push origin master
ssh root@68.183.59.19 'cd /var/www/ff3mmo && git pull && JWT_SECRET=$(cat /root/.ff3mmo_jwt_secret) pm2 restart server --update-env'
