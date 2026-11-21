ALTER TABLE team
    DROP CONSTRAINT IF EXISTS team_roster_limit_valid;

ALTER TABLE team
    DROP COLUMN IF EXISTS roster_limit;
