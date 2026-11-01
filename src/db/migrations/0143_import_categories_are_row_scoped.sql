-- Discard the batch-level category map from the earlier staged-import UI.
UPDATE public.catalog_import_batch
SET mapping = mapping - '__categoryMappings'
WHERE mapping ? '__categoryMappings';--> statement-breakpoint

-- A prior batch map must not silently qualify rows for inventory creation.
-- Keep the raw supplier category in original_values and require a row override.
UPDATE public.catalog_import_row
SET staged_values = staged_values - 'categories',
    warnings = (
      SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
      FROM jsonb_array_elements(public.catalog_import_row.warnings) AS warning(value)
      WHERE warning.value <> '"CATEGORY_MAPPING_CONFIRMATION_REQUIRED"'::jsonb
        AND warning.value <> '"CATEGORY_ALIAS_REVIEW_REQUIRED"'::jsonb
        AND warning.value <> '"CATEGORY_ROW_MAPPING_REQUIRED"'::jsonb
    ) || '["CATEGORY_ROW_MAPPING_REQUIRED"]'::jsonb,
    status = CASE WHEN status = 'READY' THEN 'NEEDS_REVIEW'::public.catalog_import_row_status ELSE status END,
    updated_at = now()
WHERE platform_category_override IS NULL
  AND status NOT IN ('APPLIED', 'REJECTED');
