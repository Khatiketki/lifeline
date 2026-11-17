resource "aws_db_subnet_group" "main" {
  name       = var.project
  subnet_ids = module.vpc.private_subnets
}

resource "aws_db_parameter_group" "pg16" {
  name   = "${var.project}-pg16"
  family = "postgres16"

  parameter {
    name  = "log_min_duration_statement"
    value = "250" # log anything slower than 250 ms
  }
  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements"
    apply_method = "pending-reboot"
  }
}

resource "aws_db_instance" "main" {
  identifier     = var.project
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.db_instance_class

  allocated_storage     = 20
  max_allocated_storage = 100
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = "lifeline"
  username = "lifeline"
  # RDS generates and rotates the password in Secrets Manager.
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  parameter_group_name   = aws_db_parameter_group.pg16.name
  multi_az               = var.db_multi_az
  publicly_accessible    = false

  backup_retention_period      = 7
  performance_insights_enabled = true
  deletion_protection          = var.db_deletion_protection
  skip_final_snapshot          = !var.db_deletion_protection
  final_snapshot_identifier    = var.db_deletion_protection ? "${var.project}-final" : null
}

locals {
  db_secret_arn = aws_db_instance.main.master_user_secret[0].secret_arn
}
