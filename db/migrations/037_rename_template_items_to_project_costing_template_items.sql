SET @project_costing_template_items_exists = (
  SELECT COUNT(*)
  FROM information_schema.tables
  WHERE table_schema = DATABASE()
    AND table_name = 'project_costing_template_items'
);

SET @template_items_exists = (
  SELECT COUNT(*)
  FROM information_schema.tables
  WHERE table_schema = DATABASE()
    AND table_name = 'template_items'
);

SET @project_consting_template_items_exists = (
  SELECT COUNT(*)
  FROM information_schema.tables
  WHERE table_schema = DATABASE()
    AND table_name = 'project_consting_template_items'
);

SET @fm_project_costing_template_items_exists = (
  SELECT COUNT(*)
  FROM information_schema.tables
  WHERE table_schema = DATABASE()
    AND table_name = 'fm_project_costing_template_items'
);

SET @fm_project_consting_template_items_exists = (
  SELECT COUNT(*)
  FROM information_schema.tables
  WHERE table_schema = DATABASE()
    AND table_name = 'fm_project_consting_template_items'
);

SET @sql = CASE
  WHEN @project_costing_template_items_exists > 0 THEN 'SELECT 1'
  WHEN @template_items_exists > 0 THEN 'RENAME TABLE `template_items` TO `project_costing_template_items`'
  WHEN @project_consting_template_items_exists > 0 THEN 'RENAME TABLE `project_consting_template_items` TO `project_costing_template_items`'
  WHEN @fm_project_costing_template_items_exists > 0 THEN 'RENAME TABLE `fm_project_costing_template_items` TO `project_costing_template_items`'
  WHEN @fm_project_consting_template_items_exists > 0 THEN 'RENAME TABLE `fm_project_consting_template_items` TO `project_costing_template_items`'
  ELSE 'SELECT 1'
END;

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
