import { Link } from 'react-router-dom';
import { t } from '../i18n/i18n';

/**
 * Shown instead of an empty table when no project is selected. A screen that
 * silently renders zero rows reads as a broken feature; this says what to do.
 */
export function NoProject(): React.JSX.Element {
  return (
    <div className="ui-state ui-state--empty">
      <p>{t('noProject.thisScreenWorksInsideA')}</p>
      <Link className="ui-button ui-button--primary ui-button--sm" to="/projects">
        {t('noProject.createAProject')}
      </Link>
    </div>
  );
}
