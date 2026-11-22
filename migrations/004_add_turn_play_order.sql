ALTER TABLE turn_score
    ADD COLUMN IF NOT EXISTS play_order INTEGER;

WITH browser_turns AS (
    SELECT
        gs.id AS submission_id,
        ROW_NUMBER() OVER (
            PARTITION BY gs.id, BTRIM(
                COALESCE(turn.value->>'player', '')
            )
            ORDER BY turn.ordinality
        ) AS player_turn_number,
        turn.ordinality - 1 AS play_order,
        BTRIM(COALESCE(turn.value->>'player', '')) AS player_name
    FROM game_submission gs
    CROSS JOIN LATERAL jsonb_array_elements(
        CASE
            WHEN jsonb_typeof(gs.raw_payload->'turns') = 'array'
                THEN gs.raw_payload->'turns'
            ELSE '[]'::JSONB
        END
    ) WITH ORDINALITY AS turn(value, ordinality)
    WHERE gs.source = 'browser'
),
browser_matches AS (
    SELECT bt.submission_id, bt.play_order, bt.player_turn_number,
           p.id AS player_id
    FROM browser_turns bt
    JOIN player p
      ON BTRIM(p.first_name || CASE
            WHEN COALESCE(p.last_name, '') = '' THEN ''
            ELSE ' ' || p.last_name
         END) = bt.player_name
)
UPDATE turn_score ts
SET play_order = bm.play_order
FROM browser_matches bm
WHERE ts.submission_id = bm.submission_id
  AND ts.player_id = bm.player_id
  AND ts.turn_number = bm.player_turn_number;

WITH ordered_unset_turns AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY match_game_id
               ORDER BY id
           ) - 1 AS play_order
    FROM turn_score
    WHERE play_order IS NULL
)
UPDATE turn_score ts
SET play_order = ordered.play_order
FROM ordered_unset_turns ordered
WHERE ts.id = ordered.id;
