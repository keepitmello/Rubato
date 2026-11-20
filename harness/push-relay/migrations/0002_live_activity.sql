-- The Live Activity card a phone started for one Mac: the token APNs updates that card with. The phone
-- sets it when it starts a card and clears it when it ends one; it says nothing about what the card shows.
ALTER TABLE grants ADD COLUMN activity_token TEXT;
