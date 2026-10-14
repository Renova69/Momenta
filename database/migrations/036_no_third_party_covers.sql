-- 036 — An album with no cover hotlinked a stock photo (N-131)
--
-- An album created from the studio's "My events" form stored an
-- images.unsplash.com photo as its cover, and the client drew the same
-- service's photo for any album without one. Every phone showing the album
-- then requested it from a third party, which learns the guest's address and
-- that a wedding is on.
--
-- No screen lets a host choose a cover, so a stored Unsplash address was always
-- that default. Those are cleared; an album with no cover now draws none.
UPDATE events
   SET cover_image_url = NULL
 WHERE cover_image_url LIKE 'https://images.unsplash.com/%';
