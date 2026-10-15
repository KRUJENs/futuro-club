import { Navigate, useParams } from "react-router-dom";

/**
 * /players/:id/role-profile/compare — RETIRADA (P1 bloque 5c, decisión del dueño 15 oct).
 *
 * Comparaba «posiciones proyectadas» y el detalle por dimensión a 0-6 / 6-18 / 18-36 meses
 * (posición + delta con pesos fijos 0,3/0,4/0,3 sobre proyecciones que eran el nivel actual
 * + un porcentaje fijo). Sin base para proyectar no queda nada que comparar: la ruta se
 * conserva para no romper enlaces guardados y lleva al perfil de rol (que muestra la
 * proyección bloqueada con su motivo).
 */
export default function RoleProfileCompare() {
  const { id } = useParams();
  return <Navigate to={id ? `/players/${id}/role-profile` : "/players"} replace />;
}
