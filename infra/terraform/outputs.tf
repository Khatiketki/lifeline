output "app_url" {
  value = "${local.https ? "https" : "http"}://${aws_lb.main.dns_name}"
}

output "ecr_repositories" {
  value = { for k, r in aws_ecr_repository.repo : k => r.repository_url }
}

output "cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "migrate_task_definition" {
  value = aws_ecs_task_definition.migrate.family
}

output "private_subnets" {
  value = module.vpc.private_subnets
}

output "tasks_security_group" {
  value = aws_security_group.tasks.id
}

output "db_endpoint" {
  value = aws_db_instance.main.address
}
