resource "aws_ecs_cluster" "main" {
  name = var.project

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

# Private DNS so services find each other: api.lifeline.local, routing.lifeline.local
resource "aws_service_discovery_private_dns_namespace" "main" {
  name = "${var.project}.local"
  vpc  = module.vpc.vpc_id
}

resource "aws_service_discovery_service" "svc" {
  for_each = toset(["api", "routing"])
  name     = each.key

  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.main.id
    routing_policy = "MULTIVALUE"
    dns_records {
      type = "A"
      ttl  = 10
    }
  }
  health_check_custom_config {
    failure_threshold = 1
  }
}

resource "aws_cloudwatch_log_group" "svc" {
  for_each          = toset(["core-api", "routing-service", "frontend", "db-migrate"])
  name              = "/ecs/${var.project}/${each.key}"
  retention_in_days = 14
}

# ---------------------------------------------------------------------------
# IAM
# ---------------------------------------------------------------------------
data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.project}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "read_db_secret" {
  name = "read-db-secret"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [local.db_secret_arn]
    }]
  })
}

# ---------------------------------------------------------------------------
# Task definitions
# ---------------------------------------------------------------------------
locals {
  image = { for k, r in aws_ecr_repository.repo : k => "${r.repository_url}:${var.image_tag}" }

  db_env = [
    { name = "PGHOST", value = aws_db_instance.main.address },
    { name = "PGPORT", value = tostring(aws_db_instance.main.port) },
    { name = "PGDATABASE", value = aws_db_instance.main.db_name },
    { name = "PGUSER", value = aws_db_instance.main.username },
  ]
  db_password_secret = [{ name = "PGPASSWORD", valueFrom = "${local.db_secret_arn}:password::" }]

  logs = { for k, g in aws_cloudwatch_log_group.svc : k => {
    logDriver = "awslogs"
    options = {
      "awslogs-group"         = g.name
      "awslogs-region"        = var.region
      "awslogs-stream-prefix" = k
    }
  } }
}

resource "aws_ecs_task_definition" "core_api" {
  family                   = "${var.project}-core-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name         = "core-api"
    image        = local.image["core-api"]
    essential    = true
    portMappings = [{ containerPort = 4000 }]
    environment = concat(local.db_env, [
      { name = "DB_SSL", value = "true" },
      { name = "ROUTING_URL", value = "http://routing.${var.project}.local:8080" },
      # Run the vitals simulator on a single dedicated task in a real
      # deployment; enabled here so the demo has live data.
      { name = "SIMULATOR", value = tostring(var.enable_simulator) },
    ])
    secrets          = local.db_password_secret
    logConfiguration = local.logs["core-api"]
  }])
}

resource "aws_ecs_task_definition" "routing" {
  family                   = "${var.project}-routing-service"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn

  container_definitions = jsonencode([{
    name         = "routing-service"
    image        = local.image["routing-service"]
    essential    = true
    portMappings = [{ containerPort = 8080 }]
    environment = [
      { name = "DB_URL", value = "jdbc:postgresql://${aws_db_instance.main.address}:${aws_db_instance.main.port}/${aws_db_instance.main.db_name}?sslmode=require" },
      { name = "DB_USER", value = aws_db_instance.main.username },
    ]
    secrets          = [{ name = "DB_PASSWORD", valueFrom = "${local.db_secret_arn}:password::" }]
    logConfiguration = local.logs["routing-service"]
  }])
}

resource "aws_ecs_task_definition" "frontend" {
  family                   = "${var.project}-frontend"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn

  container_definitions = jsonencode([{
    name             = "frontend"
    image            = local.image["frontend"]
    essential        = true
    portMappings     = [{ containerPort = 80 }]
    environment      = [{ name = "API_UPSTREAM", value = "api.${var.project}.local:4000" }]
    logConfiguration = local.logs["frontend"]
  }])
}

resource "aws_ecs_task_definition" "migrate" {
  family                   = "${var.project}-db-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn

  container_definitions = jsonencode([{
    name             = "db-migrate"
    image            = local.image["db-migrate"]
    essential        = true
    environment      = concat(local.db_env, [{ name = "PGSSLMODE", value = "require" }])
    secrets          = local.db_password_secret
    logConfiguration = local.logs["db-migrate"]
  }])
}

# ---------------------------------------------------------------------------
# Services
# ---------------------------------------------------------------------------
resource "aws_ecs_service" "routing" {
  name            = "routing-service"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.routing.arn
  desired_count   = var.routing_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = module.vpc.private_subnets
    security_groups = [aws_security_group.tasks.id]
  }
  service_registries {
    registry_arn = aws_service_discovery_service.svc["routing"].arn
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
}

resource "aws_ecs_service" "core_api" {
  name                              = "core-api"
  cluster                           = aws_ecs_cluster.main.id
  task_definition                   = aws_ecs_task_definition.core_api.arn
  desired_count                     = var.api_desired_count
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = 30

  network_configuration {
    subnets         = module.vpc.private_subnets
    security_groups = [aws_security_group.tasks.id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "core-api"
    container_port   = 4000
  }
  service_registries {
    registry_arn = aws_service_discovery_service.svc["api"].arn
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  depends_on = [aws_lb_listener_rule.api]

  lifecycle {
    ignore_changes = [desired_count] # managed by autoscaling
  }
}

resource "aws_ecs_service" "frontend" {
  name            = "frontend"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.frontend.arn
  desired_count   = 2
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = module.vpc.private_subnets
    security_groups = [aws_security_group.tasks.id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.frontend.arn
    container_name   = "frontend"
    container_port   = 80
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  depends_on = [aws_lb_listener.http, aws_ecs_service.core_api]
}

# Scale the API on CPU to hold latency under load.
resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.core_api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.api_desired_count
  max_capacity       = var.api_max_count
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${var.project}-api-cpu"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  policy_type        = "TargetTrackingScaling"

  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_in_cooldown  = 120
    scale_out_cooldown = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
