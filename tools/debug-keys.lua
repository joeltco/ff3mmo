-- Debug: print all pressed keys each frame
function on_gui()
  local inp = input.get()
  local pressed = {}
  for k, v in pairs(inp) do
    if v == true then
      pressed[#pressed+1] = k
    end
  end
  if #pressed > 0 then
    gui.text(2, 2, table.concat(pressed, ", "), "yellow")
    print("keys: " .. table.concat(pressed, ", "))
  else
    gui.text(2, 2, "(no keys)", "white")
  end
end
emu.registerafter(on_gui)
print("Key debug running — press keys to see their names")
