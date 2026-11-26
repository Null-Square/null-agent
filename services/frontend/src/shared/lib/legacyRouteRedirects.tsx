import { Navigate, useParams } from 'react-router-dom';

export function LegacyFindingDetailRedirect() {
  const { id } = useParams();
  return <Navigate to={id ? `/risks/${encodeURIComponent(id)}` : '/risks'} replace />;
}

export function LegacyExposureDetailRedirect() {
  const { id } = useParams();
  return <Navigate to={id ? `/risks/advisory/${encodeURIComponent(id)}` : '/risks'} replace />;
}
