-- Why the last dictionary lookup failed, shown to the admin.
alter table deck_words add column lookup_error text;
