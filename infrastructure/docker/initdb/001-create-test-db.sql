-- Runs only on first container init (empty volume). Creates the disposable
-- database used by @eva/database integration tests.
CREATE DATABASE eva_test;
