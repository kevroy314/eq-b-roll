-- B-roll server: make every player a camera operator, not a player.
--
-- Every new account: full GM status (255) and "god mode" flags (fly, GM run speed, invulnerable,
-- hidden from other players). Every new character: the GM flag, which NPC aggro code skips
-- entirely (zone/aggro.cpp checks GetGM()), so nothing ever attacks.
--
-- Applied automatically at every server start (see broll-entrypoint.sh); safe to re-run.
DROP TRIGGER IF EXISTS broll_account_god;
DROP TRIGGER IF EXISTS broll_character_gm;
CREATE TRIGGER broll_account_god BEFORE INSERT ON account FOR EACH ROW
  SET NEW.status = 255, NEW.flymode = 1, NEW.gmspeed = 1, NEW.gminvul = 1, NEW.hideme = 1;
CREATE TRIGGER broll_character_gm BEFORE INSERT ON character_data FOR EACH ROW
  SET NEW.gm = 1;
