-- Long view distance for video. Classic zones cap it tiny (Greater Faydark: 325 units), and the
-- client's Clip Plane slider can only move inside the server's [minclip, maxclip].
--
-- * Every zone: maxclip raised to at least 10000, so the whole zone can be drawn.
-- * Outdoor zones: fog pushed out to 2000..9500 (a light haze for depth, not a wall).
--   Dungeons keep their original fog, which is most of their mood.
-- The server's NPC update range is maxclip + 50, computed when a zone boots, so distant NPCs keep
-- moving too. Original values are kept in broll_zone_clip_orig. Safe to re-run.
CREATE TABLE IF NOT EXISTS broll_zone_clip_orig AS
  SELECT zoneidnumber, minclip, maxclip,
         fog_minclip, fog_maxclip, fog_minclip1, fog_maxclip1, fog_minclip2, fog_maxclip2,
         fog_minclip3, fog_maxclip3, fog_minclip4, fog_maxclip4
  FROM zone;

UPDATE zone SET maxclip = GREATEST(maxclip, 10000);

UPDATE zone SET
  fog_minclip  = GREATEST(fog_minclip,  2000), fog_maxclip  = GREATEST(fog_maxclip,  9500),
  fog_minclip1 = GREATEST(fog_minclip1, 2000), fog_maxclip1 = GREATEST(fog_maxclip1, 9500),
  fog_minclip2 = GREATEST(fog_minclip2, 2000), fog_maxclip2 = GREATEST(fog_maxclip2, 9500),
  fog_minclip3 = GREATEST(fog_minclip3, 2000), fog_maxclip3 = GREATEST(fog_maxclip3, 9500),
  fog_minclip4 = GREATEST(fog_minclip4, 2000), fog_maxclip4 = GREATEST(fog_maxclip4, 9500)
WHERE castoutdoor = 1;
