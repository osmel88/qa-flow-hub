-- S2-F3: a TestSuite can carry an ExternalReference (TestRail suite).
ALTER TYPE "LinkableEntity" ADD VALUE IF NOT EXISTS 'test_suite';
