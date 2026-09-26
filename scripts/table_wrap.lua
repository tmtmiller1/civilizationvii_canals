-- Force relative column widths so LaTeX tables use wrapping columns.
local DEFAULT_MIN_WIDTH = 0.12

function Table(tbl)
  local colspecs = tbl.colspecs
  local count = #colspecs
  if count == 0 then
    return tbl
  end

  local width = 1.0 / count
  if width < DEFAULT_MIN_WIDTH then
    width = DEFAULT_MIN_WIDTH
  end

  local new_colspecs = {}
  for i = 1, count do
    local align = colspecs[i][1]
    new_colspecs[i] = { align, width }
  end

  tbl.colspecs = new_colspecs
  return tbl
end
