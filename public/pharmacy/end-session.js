// End Session: a confirmation dialog, then session:end with an ack.
const ACK_TIMEOUT_MS = 10000;
const $ = (id) => document.getElementById(id);
const dialog = $('end-dialog');

// getState() -> { session, waiting, total }; onEnded(session) runs after the
// server confirms the session is closed.
export function setUpEndSession({ socket, getState, onEnded }) {
  $('end-session').addEventListener('click', () => {
    const { session, waiting, total } = getState();
    if (!session) return;
    $('end-summary').textContent = `Session ${session.id}: ${total} prescription${total === 1 ? '' : 's'}.`;
    $('end-waiting').textContent = `${waiting} ${waiting === 1 ? 'is' : 'are'} not marked Dispensed yet.`;
    $('end-waiting').hidden = waiting === 0;
    $('end-error').textContent = '';
    $('end-confirm').disabled = false;
    dialog.showModal();
    $('end-cancel').focus(); // the safe choice has focus
  });

  $('end-cancel').addEventListener('click', () => dialog.close());

  $('end-confirm').addEventListener('click', () => {
    const { session } = getState();
    if (!session) return dialog.close();
    if (!socket.connected) {
      $('end-error').textContent = 'Offline. The session is still open. Try again when connected.';
      return;
    }
    $('end-confirm').disabled = true;
    $('end-error').textContent = '';
    socket.timeout(ACK_TIMEOUT_MS).emit('session:end', { sessionId: session.id }, (err, res) => {
      $('end-confirm').disabled = false;
      if (err) return ($('end-error').textContent = 'No reply from the server. The session may still be open. Try again.');
      if (!res.ok) return ($('end-error').textContent = res.error);
      onEnded(res.session);
    });
  });
}

export function closeEndDialog() {
  if (dialog.open) dialog.close();
}
