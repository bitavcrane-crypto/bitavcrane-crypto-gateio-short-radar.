// Simulating the bug on line 724
const name = "rci";
const result = document.querySelector('[data-indicator="' + name + '"]');
console.log("querySelector result:", result);
if (result === null) {
  console.log("BUG CONFIRMED: querySelector returned null");
  try {
    const enabled = result.checked;
  } catch (e) {
    console.log("ERROR:", e.message);
  }
}
