// Exit after closing fd 0 while the parent is writing a large start frame.
process.stdin.destroy()
setTimeout(()=>process.exit(0),5)
