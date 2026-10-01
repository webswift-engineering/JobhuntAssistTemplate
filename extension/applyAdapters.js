// Per-ATS quirks consumed by applyEngine.js. Everything here is field-verified
// (from live Greenhouse and Ashby debugging sessions).
// Keep adapters DATA-ONLY where possible: selectors, regexes, tiny predicates.

(() => {
  const GREENHOUSE = {
    name: "greenhouse",
    // job page hosts the form; older postings need the Apply button clicked.
    formSelector:
      "#application-form, form[action*='applications'], #application_form, #main_fields, input#first_name",
    applyButtonRe: /^apply$|apply now|apply for this job/i,
    /** react-select: options render under select__option; a global [role=option]
     *  scan catches the phone-country flyout instead (verified on Greenhouse). */
    comboOptionSelector: "[class*='select__option'], [class*='select__menu'] [role=option]",
    /** Committed DISPLAY text (empty = nothing selected). react-select keeps the
     *  chosen label in a single-value node and clears the raw input. */
    comboValue: (input) => {
      const c = input.closest("[class*='select__control']") ?? input.parentElement?.parentElement;
      return (c?.querySelector("[class*='single-value'], [class*='multi-value']")?.textContent || "").trim();
    },
    resumeSelector: "input[type=file]",
    fullNameSingleField: false, // first_name / last_name
    yesNoSelector: null, // GH renders yes/no as react-selects — combobox path handles them
    eeoIdRe: /^(gender|hispanic_ethnicity|veteran_status|disability_status|race)/i,
    eeoSectionRe: /voluntary self[- ]identification|demographic/i,
    phoneFlyoutRe: /iti__search/,
    // "thank you for your interest" = the embed's confirmation wording; safe to
    // include because the engine also requires the form to be GONE (looksSubmitted).
    confirmationRe:
      /thank you for applying|thank you for your interest|application (was )?(submitted|received)|we have received your application/i,
    // React discards + re-renders the tree on hydration mismatch — engine's
    // hydration guard is mandatory here (React error #418, verified on Greenhouse).
  };

  const ASHBY = {
    name: "ashby",
    formSelector: "input#_systemfield_name, [class*='_jobPostingForm_']",
    // Posting page → form lives at <posting>/application; navigating preserves the hash.
    applicationSuffix: "/application",
    applyButtonRe: /apply for this job/i,
    comboOptionSelector: "[role=option]",
    /** Ashby keeps the committed text in input.value — BUT so does the text the
     *  user (or we) type, so callers must compare it against the chosen option. */
    comboValue: (input) => (input.value || "").trim(),
    resumeSelector: "#_systemfield_resume, input[type=file]",
    fullNameSingleField: true, // _systemfield_name takes the full name
    /** Yes/No = two <button class*='_option_'> + hidden checkbox inside _yesno_
     *  container — click the BUTTON, never the checkbox (verified on Ashby). */
    yesNoSelector: "[class*='_yesno_']",
    eeoIdRe: /(?!)/, // never matches — DEI questions are inline, caught by the label guard
    eeoSectionRe: /voluntary self[- ]identification|demographic/i,
    phoneFlyoutRe: /iti__search/,
    confirmationRe: /application (was )?submitted|thank you for applying|we('|’)ve received your application/i,
  };

  const LEVER = {
    name: "lever",
    formSelector: "#application-form, form[action*='apply'], input[name='name']",
    // Posting page → form lives at <posting>/apply.
    applicationSuffix: "/apply",
    applyButtonRe: /apply for this job|apply now/i,
    comboOptionSelector: "[role=option]",
    comboValue: (input) => (input.value || "").trim(),
    resumeSelector: "input[type=file]",
    fullNameSingleField: true, // single `name` field
    yesNoSelector: null,
    eeoIdRe: /$^/,
    eeoSectionRe: /equal employment|self[- ]identification|demographic/i,
    phoneFlyoutRe: /iti__search/,
    confirmationRe: /application (has been |was )?(submitted|received)|thank you/i,
  };

  window.JC_APPLY_ADAPTERS = {
    "job-boards.greenhouse.io": GREENHOUSE,
    "boards.greenhouse.io": GREENHOUSE,
    "jobs.ashbyhq.com": ASHBY,
    "jobs.lever.co": LEVER,
  };
})();
