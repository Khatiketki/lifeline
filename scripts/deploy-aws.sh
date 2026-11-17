#!/usr/bin/env bash
# Build, push and roll out Lifeline to the ECS stack created by infra/terraform.
#
#   ./scripts/deploy-aws.sh            # first run: terraform apply, migrate, deploy
#
# Requires: aws CLI (authenticated), terraform, docker.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TF="$ROOT/infra/terraform"
TAG="${IMAGE_TAG:-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || date +%s)}"
REGION="${AWS_REGION:-us-east-1}"

echo "==> Provisioning infrastructure"
terraform -chdir="$TF" init -input=false
# ECR must exist before images can be pushed.
terraform -chdir="$TF" apply -input=false -auto-approve -var "region=$REGION" -target=aws_ecr_repository.repo

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"

echo "==> Building and pushing images ($TAG)"
declare -A CONTEXTS=(
  [core-api]="$ROOT/services/core-api"
  [routing-service]="$ROOT/services/routing-service"
  [frontend]="$ROOT/frontend"
  [db-migrate]="$ROOT/db"
)
for name in "${!CONTEXTS[@]}"; do
  image="$REGISTRY/lifeline/$name:$TAG"
  docker build --platform linux/amd64 -t "$image" "${CONTEXTS[$name]}"
  docker push "$image"
done

echo "==> Applying full stack"
terraform -chdir="$TF" apply -input=false -auto-approve -var "region=$REGION" -var "image_tag=$TAG"

CLUSTER="$(terraform -chdir="$TF" output -raw cluster_name)"
SUBNETS="$(terraform -chdir="$TF" output -json private_subnets | tr -d '[]" \n')"
SG="$(terraform -chdir="$TF" output -raw tasks_security_group)"

echo "==> Running database migrations"
TASK_ARN="$(aws ecs run-task --region "$REGION" --cluster "$CLUSTER" \
  --task-definition "$(terraform -chdir="$TF" output -raw migrate_task_definition)" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=DISABLED}" \
  --query 'tasks[0].taskArn' --output text)"
aws ecs wait tasks-stopped --region "$REGION" --cluster "$CLUSTER" --tasks "$TASK_ARN"
EXIT_CODE="$(aws ecs describe-tasks --region "$REGION" --cluster "$CLUSTER" --tasks "$TASK_ARN" --query 'tasks[0].containers[0].exitCode' --output text)"
[ "$EXIT_CODE" = "0" ] || { echo "migration failed (exit $EXIT_CODE); see /ecs/lifeline/db-migrate logs"; exit 1; }

echo "==> Reloading routing graph and waiting for services"
aws ecs update-service --region "$REGION" --cluster "$CLUSTER" --service routing-service --force-new-deployment >/dev/null
aws ecs wait services-stable --region "$REGION" --cluster "$CLUSTER" --services routing-service core-api frontend

echo "==> Deployed: $(terraform -chdir="$TF" output -raw app_url)"
