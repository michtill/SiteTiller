// The app's one confirm dialog (documentation 0.5, one interface library): the Content editor, Structure, AI Studio
// and the Shell settings ask with it, never with the browser's own dialog. Plain JavaScript, so the Shell serves it
// as is and the studios import it. Its look is confirm-dialog.css, loaded by every part as a file (the AI Studio
// allows no inline styles). Esc and a click outside are Cancel.

/**
 * Asks and waits for the answer.
 * @param {{ title: string, message: string, confirm: string, cancel: string, label?: string }} text
 * @returns {Promise<boolean>} true for Confirm
 */
export function confirmDialog({ title, message, confirm, cancel, label }) {
  const dialog = document.createElement('dialog'),
    heading = document.createElement('h2'),
    text = document.createElement('p'),
    footer = document.createElement('footer'),
    no = document.createElement('button'),
    yes = document.createElement('button'),
    back = document.activeElement;
  dialog.className = 'ui-confirm';
  dialog.setAttribute('aria-label', label || title);
  heading.textContent = title;
  text.textContent = message;
  no.type = yes.type = 'button';
  no.textContent = cancel;
  yes.textContent = confirm;
  yes.className = 'ui-confirm-ok';
  footer.append(no, yes);
  dialog.append(heading, text, footer);
  document.body.append(dialog);
  return new Promise((resolve) => {
    const close = (answer) => {
      dialog.close();
      dialog.remove();
      if (back instanceof HTMLElement) back.focus();
      resolve(answer);
    };
    no.addEventListener('click', () => close(false));
    yes.addEventListener('click', () => close(true));
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      close(false);
    });
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) {
        const box = dialog.getBoundingClientRect();
        if (
          event.clientX < box.left ||
          event.clientX > box.right ||
          event.clientY < box.top ||
          event.clientY > box.bottom
        )
          close(false);
      }
    });
    dialog.showModal();
    no.focus();
  });
}

// Pages without a framework (the Shell settings): a submit button with data-confirm (the question) and
// data-confirm-title / -ok / -cancel asks first; Confirm sends its form with confirm=yes. Without scripts the
// server asks on its own page.
export function confirmButtons(root = document) {
  for (const button of root.querySelectorAll('button[data-confirm]'))
    button.addEventListener('click', async (event) => {
      if (button.dataset.confirmed) return;
      event.preventDefault();
      const answer = await confirmDialog({
        title: button.dataset.confirmTitle || '',
        message: button.dataset.confirm || '',
        confirm: button.dataset.confirmOk || 'OK',
        cancel: button.dataset.confirmCancel || 'Cancel',
      });
      if (!answer || !button.form) return;
      const confirmed = document.createElement('input');
      confirmed.type = 'hidden';
      confirmed.name = 'confirm';
      confirmed.value = 'yes';
      button.form.append(confirmed);
      button.dataset.confirmed = '1';
      button.click();
    });
}
