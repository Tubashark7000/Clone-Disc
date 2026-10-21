const hue = (s) => [...s].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;

export default function Avatar({ name, size = 40, className = "" }) {
  return (
    <div
      className={`grid shrink-0 place-items-center rounded-full font-semibold text-white ${className}`}
      style={{ width: size, height: size, fontSize: size * 0.42, backgroundColor: `hsl(${hue(name)} 50% 42%)` }}
    >
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}
