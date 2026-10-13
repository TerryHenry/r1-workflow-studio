// Sample workflows for the editor's "Samples" list. Built with the editor's own model, so they can be opened, clicked through
// ("Try it"), edited and applied like any other workflow. They don't point at anything in your tenant: DPSK pools and SSIDs are
// created new, and the two things only you can supply (an LDAP directory profile, a certificate authority) are left blank and flagged.
const m = require("./model");

const node = (type, name, params = {}, extra = {}) => { const n = m.newNode(type, name); Object.assign(n.params, params); Object.assign(n, extra); return n; };
const opt = (name, text, steps, conditions) => ({ ...m.newOption(name), text, steps, ...(conditions ? { conditions } : {}) });
const note = (n, text) => { n.source = { notes: [text] }; return n; };

function dpsk(name, pool, ssid, extra = {}) {
  return node("DPSK", name, { mode: "new", newName: pool, passphraseFormat: "KEYBOARD_FRIENDLY", passphraseLength: 10, ssids: ssid ? [{ ssid }] : [], qrCodeDisplay: true, ...extra });
}
const ldap = (name) => note(node("LDAP_AUTH_PROVIDER", name, { directoryServerProfileId: "" }), "Enter the id of your directory server (LDAP) profile from RUCKUS One. It can't be filled in for you.");

function school() {
  const wf = {
    name: "School: student, teacher or guest",
    description: "Visitors say who they are. Students and teachers sign in with the school directory and get their own passphrase; guests give their details and get a short-lived one.",
    steps: [
      node("AUP", "School network policy", { title: "Welcome to Lincoln High", messageHtml: "Please read and accept the school's network policy to continue.", aupPlainText: "Use the network for school work. Do not try to bypass filtering. Activity may be logged.", checkboxText: "I agree to the network policy" }),
      node("USER_SELECTION_SPLIT", "Who are you?", { title: "Who are you?" }, { options: [
        opt("Student", "Sign in with your school account", [ldap("Student sign-in"), dpsk("Student passphrase", "Student devices", "School-Students", { deviceCountLimit: 3 })]),
        opt("Teacher", "Sign in with your school account", [ldap("Teacher sign-in"), dpsk("Teacher passphrase", "Teacher devices", "School-Staff", { deviceCountLimit: 5 })]),
        opt("Guest", "Visiting for the day", [
          node("DATA_PROMPT", "Guest details", { title: "Tell us who you are", variables: [{ label: "Full name", type: "USER_NAME" }, { label: "Email", type: "EMAIL" }, { label: "Visiting", type: "INPUT_FIELD_1" }] }),
          dpsk("Guest passphrase", "School guests", "School-Guest", { expirationType: "DAYS_AFTER_TIME", expirationOffset: 1, deviceCountLimit: 1, emailNotification: true }),
        ]),
      ] }),
    ],
    look: { ...JSON.parse(JSON.stringify(m.DEFAULT_LOOK)), welcomeTitle: "Lincoln High School Wi-Fi", welcomeName: "Connect to the school network", colors: { ...m.DEFAULT_LOOK.colors, headerBarBackgroundColor: "#1F4E9C", buttonColor: "#1F4E9C", backgroundColor: "#F2F5FA" } },
  };
  return wf;
}

function employeeGuest() {
  return {
    name: "Employee (LDAP) or guest (DPSK)",
    description: "Employees sign in with the company directory and get a passphrase for the staff network. Guests accept the terms, leave an email address, and get a one-day passphrase for the guest network.",
    steps: [
      node("USER_SELECTION_SPLIT", "Employee or guest?", { title: "Welcome" }, { options: [
        opt("Employee", "Sign in with your company account", [ldap("Employee sign-in"), dpsk("Employee passphrase", "Employee devices", "Corp-Staff", { deviceCountLimit: 4 })]),
        opt("Guest", "Visiting us today", [
          node("AUP", "Guest terms", { title: "Guest Wi-Fi", messageHtml: "Please accept the guest network terms.", aupPlainText: "Guest access is provided for one day. Do not use it for anything unlawful.", checkboxText: "I accept the guest terms" }),
          node("DATA_PROMPT", "Guest email", { title: "Where should we send your password?", variables: [{ label: "Email", type: "EMAIL" }] }),
          dpsk("Guest passphrase", "Guest devices", "Corp-Guest", { expirationType: "DAYS_AFTER_TIME", expirationOffset: 1, deviceCountLimit: 1, emailNotification: true }),
        ]),
      ] }),
    ],
  };
}

function byDevice() {
  const cert = note(node("CERT_TEMPLATE", "Laptop certificate", { mode: "new", newName: "Laptop certificate", commonNamePattern: "$(USERNAME)@example.com", validityType: "YEARS", validityValue: 1, caId: "" }),
    "Choose the certificate authority that should issue these certificates.");
  return {
    name: "Phones and tablets vs laptops",
    description: "A logical split: R1 looks at the visitor's device and decides the path automatically. Computers (device type contains Desktop) get a certificate; everything else gets a passphrase.",
    steps: [
      node("AUP", "Network policy", { title: "Welcome", messageHtml: "Please accept the network policy to continue." }),
      node("LOGICAL_SPLIT", "Device check", {}, { options: [
        // Confirmed on a real device (2026-10-13): a MacBook reports a device type containing "Desktop". What phones report is not known yet,
        // so the other branch is "does not contain Desktop" rather than a guessed word.
        { ...opt("Computer", "", [cert], [{ variable: "CP_DEVICE_TYPE", operation: "CONTAINS", value: "Desktop" }]) },
        { ...opt("Phone or tablet", "", [dpsk("Mobile passphrase", "Phone and tablet devices", "Corp-Mobile", { deviceCountLimit: 2 })], [{ variable: "CP_DEVICE_TYPE", operation: "DOES_NOT_CONTAIN", value: "Desktop" }]) },
      ] }),
    ],
  };
}

// [{ id, name, blurb, workflow }]
function samples() {
  return [
    { id: "school", name: "School: student / teacher / guest", blurb: "A choice at the start. Students and teachers sign in with LDAP and get their own DPSK pools; guests give details and get a one-day passphrase. Includes a custom look.", workflow: school() },
    { id: "employee-guest", name: "Employee (LDAP) or guest (DPSK)", blurb: "Employees sign in with the directory and get a staff passphrase. Guests accept terms, give an email and get a one-day passphrase.", workflow: employeeGuest() },
    { id: "by-device", name: "Phones and tablets vs laptops", blurb: "A logical split by device type: phones and tablets get a passphrase, laptops get a certificate. Try it with different device types.", workflow: byDevice() },
  ].map((s) => ({ ...s, workflow: { ...s.workflow, source: { sample: s.id, sampleNote: s.blurb } } }));
}

module.exports = { samples };
