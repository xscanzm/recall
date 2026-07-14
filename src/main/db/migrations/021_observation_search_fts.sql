CREATE VIRTUAL TABLE observation_search_fts USING fts5(
  observation_id UNINDEXED,
  body,
  captured_at UNINDEXED,
  tokenize = 'trigram'
);

INSERT INTO observation_search_fts
SELECT id,
       COALESCE(user_facing_summary, '') || ' ' || scene_summary || ' ' ||
       window_title || ' ' || app_name || ' ' || COALESCE(url_or_domain, '') || ' ' ||
       visible_content_json,
       captured_at
FROM observations;

CREATE TRIGGER observation_search_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observation_search_fts VALUES (
    new.id,
    COALESCE(new.user_facing_summary, '') || ' ' || new.scene_summary || ' ' ||
    new.window_title || ' ' || new.app_name || ' ' || COALESCE(new.url_or_domain, '') || ' ' ||
    new.visible_content_json,
    new.captured_at
  );
END;

CREATE TRIGGER observation_search_au AFTER UPDATE ON observations BEGIN
  DELETE FROM observation_search_fts WHERE observation_id = old.id;
  INSERT INTO observation_search_fts VALUES (
    new.id,
    COALESCE(new.user_facing_summary, '') || ' ' || new.scene_summary || ' ' ||
    new.window_title || ' ' || new.app_name || ' ' || COALESCE(new.url_or_domain, '') || ' ' ||
    new.visible_content_json,
    new.captured_at
  );
END;

CREATE TRIGGER observation_search_ad AFTER DELETE ON observations BEGIN
  DELETE FROM observation_search_fts WHERE observation_id = old.id;
END;
