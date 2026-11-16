# 74. Internationalizing the Web without a library

This chapter is about the client, but the decisions are the same ones a
backend makes when it designs an error contract: what is a key, what is data,
and who owns the wording.

## 1. Keys, not strings

Every visible text is looked up by a typed key:

```ts
t('projects.createProject'); // "Create project" / "Crear proyecto"
t('dashboard.executedOfCases', { executed: 12, planned: 40 });
```

English (`messages/en/*.ts`) is the source catalog and defines the
`MessageKey` type, so a misspelt key is a compile error. Spanish
(`messages/es/*.ts`) may lack a key; `translate()` then falls back to English,
and a unit test makes sure that never happens by accident.

Placeholders carry the dynamic parts. Building "12 of 40 cases" from three
fragments would hard-code English word order; one template per language lets
each language place the numbers where its grammar wants them.

## 2. Values are data

A status such as `in_progress` comes from the API and is also used in filters
and requests. It must never be translated where it is sent back. The Web
translates only where it renders, through one function:

```ts
export function valueLabel(value: string): string {
  const catalog = CATALOGS[activeLocale] as Record<string, string | undefined>;
  return catalog[`value.${value}`] ?? value.replace(/_/g, ' ');
}
```

A new enum value added by the backend renders immediately, readable in
English, and is translated when the catalog gains `value.<raw>`.

## 3. Shared packages stay independent

`packages/ui` must not import the Web's i18n. Its defaults (loading, empty,
error, show/hide password) come from a React context with English defaults;
the Web fills it from the catalogs. This is dependency inversion: the
component library declares what it needs, the application provides it.

## 4. Validation and API errors

The Zod schemas are shared with the API, so their messages stay in English.
The Web maps the known messages to keys in one file (`i18n/validation.ts`).
API errors are a different matter: matching their text would couple the Web
to wording the API can change at any time. The right fix is on the backend —
a stable `errorCode` in the error body — and is recorded as debt 69.

## Exercises

1. Add `errorCode` to the API error filter and translate one error by code.
2. Use `intlLocale()` in the date formatter and test both locales.
