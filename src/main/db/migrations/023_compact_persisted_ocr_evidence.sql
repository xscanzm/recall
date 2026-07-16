-- OCR block coordinates and visual signatures are transient processing state.
-- Keep complete OCR text/lines, but remove geometry-heavy fields already stored
-- in historical observations.
UPDATE observations
SET visible_content_json = COALESCE((
  SELECT json_group_array(json(
    CASE
      WHEN json_type(item.value, '$.ocrEvidence') IS NOT NULL THEN
        json_remove(
          item.value,
          '$.ocrEvidence.blocks',
          '$.ocrEvidence.delta',
          '$.ocrEvidence.screenSignature'
        )
      ELSE item.value
    END
  ))
  FROM json_each(observations.visible_content_json) AS item
), '[]')
WHERE instr(visible_content_json, '"ocrEvidence"') > 0;
